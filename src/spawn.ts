// src/spawn.ts
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, win32 } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface SpawnResult {
    pid: number;
    logPath: string;
    exit: Promise<number | null>;
}

export interface ShellInvocation {
    shell: string;
    args: string[];
}

/** Resolve shellPath through pi's settings manager so project trust is preserved. */
export function resolveConfiguredWindowsShellPath(
    cwd: string,
    projectTrusted = false,
    agentDir = getAgentDir()
): string | undefined {
    return SettingsManager.create(cwd, agentDir, { projectTrusted }).getShellPath();
}

/** Build a platform-appropriate shell invocation without involving a parent shell. */
export function buildShellInvocation(
    command: string,
    shellPath?: string,
    platform: NodeJS.Platform = process.platform
): ShellInvocation {
    if (platform !== "win32" || !shellPath) {
        return { shell: "bash", args: ["-c", command] };
    }

    const shellName = win32.basename(shellPath).toLowerCase();
    if (shellName === "cmd" || shellName === "cmd.exe") {
        return { shell: shellPath, args: ["/d", "/s", "/c", command] };
    }
    if (
        shellName === "pwsh" ||
        shellName === "pwsh.exe" ||
        shellName === "powershell" ||
        shellName === "powershell.exe"
    ) {
        return {
            shell: shellPath,
            args: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                command,
            ],
        };
    }
    return { shell: shellPath, args: ["-c", command] };
}

/**
 * Spawn a child with stdout+stderr written directly to a file descriptor — the
 * Claude Code pattern: the kernel writes output to disk with zero JS in the
 * data path. Progress is read back by polling the file tail separately.
 *
 * Pass `command` to run the configured shell (`bash` by default), or
 * `file`/`fileArgs` to exec a binary directly (e.g. agent_bg launching `pi -p`).
 * POSIX children are detached so the whole process group can be signalled;
 * Windows uses `taskkill /T` instead.
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
    /** Whether project-local settings are trusted for shellPath resolution. */
    projectTrusted?: boolean;
    /** Explicit shell override. `null` bypasses settings and keeps the default bash. */
    shellPath?: string | null;
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

    const configuredShell =
        args.shellPath === undefined
            ? process.platform === "win32"
                ? resolveConfiguredWindowsShellPath(args.cwd, args.projectTrusted)
                : undefined
            : args.shellPath ?? undefined;
    const invocation = args.file
        ? { shell: args.file, args: args.fileArgs ?? [] }
        : buildShellInvocation(args.command ?? "", configuredShell);
    const bin = invocation.shell;
    const binArgs = invocation.args;

    let proc;
    try {
        proc = spawn(bin, binArgs, {
            stdio: ["ignore", outFd, errFd],
            cwd: args.cwd,
            detached: process.platform !== "win32",
            env: { ...process.env },
            windowsHide: process.platform === "win32",
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
        proc.on("error", (error) => {
            try {
                appendFileSync(
                    args.errPath ?? args.logPath,
                    `Failed to spawn ${bin}: ${error.message}\n`,
                    "utf8"
                );
            } catch {
                /* best-effort */
            }
            resolve(1);
        });
    });

    // Spawn failures are asynchronous on Node. A zero pid keeps the failure
    // observable through `exit` and the log instead of throwing an empty error.
    const pid = proc.pid ?? 0;

    // Kill the process group on abort. Most callers manage abort themselves and
    // do not pass a signal; this is offered for direct/background spawns.
    const onAbort = () => killProcessTree(pid);
    if (args.signal) {
        if (args.signal.aborted) onAbort();
        else args.signal.addEventListener("abort", onAbort, { once: true });
    }
    void exit.finally(() => args.signal?.removeEventListener("abort", onAbort));

    proc.unref();

    return { pid, logPath: args.logPath, exit };
}

/**
 * Kill an entire process tree. Windows uses taskkill; POSIX signals the
 * detached process group and falls back to the direct PID.
 */
export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    const killDirect = () => {
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    };
    if (process.platform === "win32") {
        try {
            const killer = spawn(
                "taskkill.exe",
                ["/F", "/T", "/PID", String(pid)],
                { stdio: "ignore", detached: true, windowsHide: true }
            );
            killer.once("error", killDirect);
            killer.once("close", (code) => {
                if (code !== 0) killDirect();
            });
            killer.unref();
            return;
        } catch {
            killDirect();
            return;
        }
    }
    try {
        process.kill(-pid, signal);
    } catch {
        killDirect();
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
