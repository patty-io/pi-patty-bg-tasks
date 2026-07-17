// src/spawn.ts
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnResult {
    pid: number;
    logPath: string;
    exit: Promise<number | null>;
    /** Re-detach the child from the event loop. Used when a foreground command
     *  (spawned with keepRef:true so its `close` fires in -p mode) is promoted
     *  to a background job: once backgrounded it must be able to outlive the
     *  turn, so it should no longer hold the loop open. Idempotent. */
    unref: () => void;
}

/**
 * Spawn a child with stdout+stderr written directly to a file descriptor — the
 * Claude Code pattern: the kernel writes output to disk with zero JS in the
 * data path. Progress is read back by polling the file tail separately.
 *
 * Pass `command` to run `bash -c <command>`, or `file`/`fileArgs` to exec a
 * binary directly (e.g. a helper launching a binary directly). The child is detached so
 * the whole process group can be signalled.
 */
export function spawnWithFileOutput(args: {
    command?: string;
    file?: string;
    fileArgs?: string[];
    cwd: string;
    logPath: string;
    /** When set, stderr is written here instead of merged into logPath. Used by
     *  the monitor tool so stdout is a clean event stream and stderr is captured
     *  separately (readable, but never emitted as an event). */
    errPath?: string;
    signal?: AbortSignal;
    /** Keep the child ref'd so it holds the event loop alive until it exits.
     *  Foreground commands need this so their `close` event is delivered in
     *  non-interactive (-p) mode where no TUI keeps the loop alive. Detached
     *  background jobs must stay unref'd so they can outlive the turn. */
    keepRef?: boolean;
}): SpawnResult {
    mkdirSync(dirname(args.logPath), { recursive: true });
    const outFd = openSync(args.logPath, "w");
    let errFd: number;
    try {
        errFd = args.errPath ? openSync(args.errPath, "w") : outFd;
    } catch (err) {
        closeSync(outFd);
        throw err;
    }

    const [bin, binArgs]: [string, string[]] = args.file
        ? [args.file, args.fileArgs ?? []]
        : ["bash", ["-c", args.command ?? ""]];

    let proc;
    try {
        proc = spawn(bin, binArgs, {
            stdio: ["ignore", outFd, errFd],
            cwd: args.cwd,
            detached: true,
            env: { ...process.env },
        });
    } finally {
        closeSync(outFd);
        if (errFd !== outFd) closeSync(errFd);
    }

    // Build the exit promise and attach the 'error' listener BEFORE any throw,
    // so an asynchronous spawn failure (ENOENT / EMFILE / EAGAIN) can never
    // surface as an uncaught exception that takes pi down.
    const exit = new Promise<number | null>((resolve) => {
        proc.on("close", (code) => resolve(code));
        proc.on("error", () => resolve(1));
    });

    if (!proc.pid) {
        try { unlinkSync(args.logPath); } catch { /* best-effort */ }
        if (args.errPath) {
            try { unlinkSync(args.errPath); } catch { /* best-effort */ }
        }
        throw new Error("Failed to spawn process");
    }
    const pid = proc.pid;

    // Kill the process group on abort. Most callers manage abort themselves and
    // do not pass a signal; this is offered for direct/background spawns.
    const onAbort = () => killProcessTree(pid);
    if (args.signal) {
        if (args.signal.aborted) onAbort();
        else args.signal.addEventListener("abort", onAbort, { once: true });
    }
    void exit.finally(() => args.signal?.removeEventListener("abort", onAbort));

    if (!args.keepRef) proc.unref();

    return { pid, logPath: args.logPath, exit, unref: () => proc.unref() };
}

/**
 * Kill an entire process group via negative PID signal.
 * Falls back to direct PID kill if group kill fails.
 */
export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Cheap liveness probe via signal 0. */
export function processExists(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}
