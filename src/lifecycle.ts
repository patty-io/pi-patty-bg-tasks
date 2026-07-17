/**
 * Lifecycle helpers for background jobs.
 *
 * Collects the cross-cutting concerns — completion notification, timeout
 * scheduling, terminal-state marking, and cleanup (kill) — in one place.
 * Monitoring (progress polling, stall detection) lives in monitoring.ts.
 */

import { statSync as fsStatSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    BG_TASK_FINISHED_EVENT,
    DELIVER_FOLLOWUP,
    EVENT,
    MAX_CONCURRENT_JOBS,
    type Job,
    type JobStatus,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { killProcessTree, processExists } from "./spawn.ts";
import { clearLive } from "./shared-live.ts";
import { LOG_DIR, atConcurrencyLimit, forget, renderSidebar } from "./registry.ts";
import { watchStalls } from "./monitoring.ts";
import { enqueueFinished } from "./notify.ts";
import { formatDuration, jobLabel } from "./format.ts";

// --- Background-job orchestration ----------------------------------------

/** Throw a standard error when no concurrency slot is free. */
export function assertJobSlot(reg: BackgroundRegistry): void {
    if (atConcurrencyLimit(reg)) {
        throw new Error(
            `Max concurrent background jobs (${MAX_CONCURRENT_JOBS}) reached. ` +
                `Kill or wait for existing jobs before starting new ones.`
        );
    }
}

/**
 * Wire a background job's lifecycle: completion promise, abort controller,
 * stall watcher, and the exit→completeJob hand-off. The job must already be in
 * the registry. Returns the job's AbortController so callers can attach extra
 * monitors (e.g. a job's progress poller).
 */
export function startBackgroundJob(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    job: Job;
    exit: Promise<number | null>;
    shouldNotify?: boolean;
    /** Suppress the interactive-prompt stall heuristic (monitors stream their
     *  own output, so a quiet tail is normal, not a stuck prompt). */
    disablePromptStall?: boolean;
    /** Suppress the oversize auto-kill (persistent log tails are expected to
     *  grow without bound). */
    disableOversizeKill?: boolean;
    onExit?: (code: number | null) => void;
}): AbortController {
    ensureCompletionPromise(args.job);
    const jobAc = createJobAbort(args.reg, args.job.id);
    const cancelStall = watchStalls({
        jobId: args.job.id,
        command: args.job.command,
        logPath: args.job.logPath,
        pi: args.pi,
        disablePromptStall: args.disablePromptStall,
        disableOversizeKill: args.disableOversizeKill,
        onOversize: () => terminateJobSilently(args.reg, args.job),
    });
    jobAc.signal.addEventListener("abort", cancelStall, { once: true });
    void args.exit.then((code) => {
        args.onExit?.(code);
        completeJob({
            job: args.job,
            code,
            reg: args.reg,
            pi: args.pi,
            ctx: args.ctx,
            shouldNotify: args.shouldNotify,
        });
    });
    renderSidebar(args.reg, args.ctx);
    return jobAc;
}

// --- Terminal-state marking ----------------------------------------------

/**
 * Standard completion flow after a job exits — abortJob → markTerminal →
 * notifyFinished → forget → renderSidebar. Shared by every tool's exit
 * callback (bash, bash_bg) as the canonical termination protocol.
 */
export function completeJob(args: {
    job: Job;
    code: number | null | undefined;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    shouldNotify?: boolean;
}): void {
    if (args.job.status !== "running") return;
    // The caller passes the authoritative Job (the object held in the registry),
    // so no lookup is needed.
    const finished = args.job;
    abortJob(args.reg, finished.id);
    markTerminal(finished, statusFromExit(args.code), args.code ?? undefined);
    // Emit a real-time bus event the instant the job is terminal (mid-turn, from
    // the child's exit callback) — separate from the coalesced turn-boundary user
    // notice. Lets other extensions (e.g. a `wait` tool) react immediately to a
    // background job finishing. Best-effort: never let a subscriber throw break
    // the termination protocol.
    try {
        args.pi.events.emit(BG_TASK_FINISHED_EVENT, {
            jobId: finished.id,
            name: finished.name,
            command: finished.command,
            status: finished.status,
            exitCode: finished.exitCode,
            pid: finished.pid,
            kind: finished.kind ?? "shell",
            logPath: finished.logPath,
            startTime: finished.startTime,
            endedAt: finished.endedAt ?? Date.now(),
        });
    } catch {
        /* a bad subscriber must not break job completion */
    }
    if (args.shouldNotify !== false) {
        notifyFinished({ job: finished, reg: args.reg, pi: args.pi, ctx: args.ctx });
    }
    forget(args.reg, finished);
    renderSidebar(args.reg, args.ctx);
}

/**
 * Mark a job terminal and resolve its donePromise. Idempotent — already-
 * terminal jobs are ignored. The proc reference is dropped explicitly for GC.
 */
export function markTerminal(
    job: Job,
    status: JobStatus,
    exitCode?: number
): void {
    if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "killed"
    ) {
        return;
    }
    job.status = status;
    job.exitCode = exitCode;
    delete job.proc;
    // Drop from the cross-extension live-jobs set (see shared-live.ts). Single
    // choke point for every terminal transition (complete/fail/kill), so a
    // `wait` tool reading the set never sees a stale in-flight job.
    clearLive(job.id);
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
    delete job.donePromise;
}

/** Map an exit code to a JobStatus. null is treated as a signal exit (cancel) → completed. */
export function statusFromExit(code: number | null | undefined): JobStatus {
    return code === 0 || code === null ? "completed" : "failed";
}

/**
 * Create a job's donePromise. This is the entry point that attach/log-wait
 * flows await for a result. Idempotent — does not recreate an existing promise.
 */
export function ensureCompletionPromise(job: Job): void {
    if (job.donePromise) return;
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

/**
 * Mark a job "killed" and set the output-consumed flag, so the exit callback
 * does not emit a spurious completion notification on any termination path.
 * Delegates the flag set to `markOutcomeKnown` so there's a single assignment
 * site for `outputConsumed` (this can't drift if the flag ever gains side
 * effects). `markTerminal` flips status to "killed" first, so the
 * running-guard in `markOutcomeKnown` correctly lets the set through.
 */
export function markKilledSilently(job: Job): void {
    markTerminal(job, "killed");
    markOutcomeKnown(job);
}

/**
 * Mark a job's outcome as already-known to the agent — Claude Code's `notified`
 * flag in parity. Called whenever the agent learns the result through any path
 * OTHER than the completion notice itself: `jobs output`, a `job_decide`
 * decision, or `jobs attach` (terminal branch). The pending completion notice
 * is then suppressed — at enqueue time (`enqueueFinished`) AND at flush time
 * (`sendCoalescedNotice`) so a flag flipped while a job is parked mid-turn
 * still takes effect. No-op for a still-running job (the agent hasn't seen the
 * final outcome yet, so the later notice should fire).
 */
export function markOutcomeKnown(job: Job): void {
    if (job.status === "running") return;
    job.outputConsumed = true;
}

/** Kill a job quietly and abort its registered monitors/timers. */
export function terminateJobSilently(reg: BackgroundRegistry, job: Job): void {
    terminateJob(job);
    markKilledSilently(job);
    abortJob(reg, job.id);
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
}

/** True when the exit code matches a SIGKILL/SIGTERM pattern — lets callers
 *  expecting a clean exit treat it as an intended cancellation. */
export function isSignalExit(code: number | null | undefined): boolean {
    return code === 137 || code === 143;
}

// --- Per-job abort (cleanup) ---------------------------------------------

/** Create an AbortController for a job. Aborting it cancels all monitors. */
export function createJobAbort(
    reg: BackgroundRegistry,
    jobId: string
): AbortController {
    const existing = reg.jobAborts.get(jobId);
    if (existing) return existing;
    const ac = new AbortController();
    reg.jobAborts.set(jobId, ac);
    return ac;
}

/** Abort all monitors for a job and remove the controller. */
export function abortJob(reg: BackgroundRegistry, jobId: string): void {
    const ac = reg.jobAborts.get(jobId);
    if (ac) {
        ac.abort();
        reg.jobAborts.delete(jobId);
    }
}

/**
 * Kill a job — SIGTERM the live process group if the proc handle is present,
 * otherwise signal the recorded PID directly (covers rehydrated jobs that have
 * no proc handle after session restore).
 */
export function terminateJob(job: Job): void {
    // Monitors carry a transient teardown hook (follower + ws socket). A ws
    // monitor has pid 0, so the process-tree kill below is a no-op for it and
    // job.stop does the real work; a command monitor needs both.
    job.stop?.();
    if (job.proc && processExists(job.proc.pid)) {
        killProcessTree(job.proc.pid, "SIGTERM");
        return;
    }
    if (job.pid > 0 && processExists(job.pid)) {
        killProcessTree(job.pid, "SIGTERM");
    }
}

// --- Foreground backgrounding --------------------------------------------

/** Richer context for Ctrl+B / `/bg`: the UI plus the turn-control surface
 *  (idle check and whether a user message is already queued). */
export type ControlContext = UiContext & {
    isIdle(): boolean;
    hasPendingMessages(): boolean;
};

/**
 * Flip the active foreground command into the background. Pure mechanic — no
 * toast, no agent message. Returns false when there is nothing in the
 * foreground to pause. Callers compose the messaging.
 */
export function pauseActiveForeground(reg: BackgroundRegistry, ctx: UiContext): boolean {
    if (!reg.activeToolCallId) return false;
    const toolCallId = reg.activeToolCallId;
    const slot = reg.foreground.get(toolCallId);
    if (!slot) return false;

    slot.requestPause("manual");
    reg.foreground.delete(toolCallId);
    if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
    renderSidebar(reg, ctx);
    return true;
}

/** Tell the agent a command was backgrounded so it acknowledges and continues. */
export function sendBackgroundNotice(pi: ExtensionAPI): void {
    pi.sendMessage(
        {
            customType: EVENT.background,
            content:
                `Command was manually backgrounded by user. ` +
                `Output is being captured. ` +
                `You can continue working — use the jobs tool to check on it later.`,
            display: true,
        },
        DELIVER_FOLLOWUP
    );
}

/** Move the current foreground command to the background and send the agent a follow-up. */
export function backgroundActiveForeground(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    options?: { notifyAgent?: boolean }
): boolean {
    if (!pauseActiveForeground(reg, ctx)) return false;
    ctx.ui.notify("▶ Backgrounded — continuing.", "info");

    // Cooperative steering (input.ts) delivers the user's own message as the
    // follow-up, so it suppresses this synthetic notice to avoid a duplicate
    // agent message and an extra turn. Ctrl+Shift+B / /bg have no user text and
    // keep it.
    if (options?.notifyAgent === false) return true;
    sendBackgroundNotice(pi);
    return true;
}

/** Outcome of a Ctrl+B / `/bg` control-handover. */
export type ControlOutcome = "backgrounded" | "queued" | "nothing";

/**
 * Claude Code's Ctrl+B, faithfully: background the running foreground command.
 *
 * It deliberately does NOT call ctx.abort(): in pi, aborting restores any queued
 * message to the editor (unsent), renders a scary "Operation aborted", AND kills
 * the running process — exactly the data-loss we must avoid. Instead, like
 * Claude Code, backgrounding makes the bash tool return; the turn ends and any
 * queued message drains at the natural turn boundary.
 */
export function takeControl(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: ControlContext
): ControlOutcome {
    if (pauseActiveForeground(reg, ctx)) {
        sendBackgroundNotice(pi);
        ctx.ui.notify("▶ Backgrounded — continuing.", "info");
        return "backgrounded";
    }

    // Nothing in the foreground to background. If a message is queued behind the
    // current turn, set expectations rather than abort (abort would lose it).
    if (!ctx.isIdle() && ctx.hasPendingMessages()) {
        ctx.ui.notify("Message queued — it'll send when the current step finishes.", "info");
        return "queued";
    }

    ctx.ui.notify("No running process to background.", "warning");
    return "nothing";
}

// --- Completion notification ---------------------------------------------

/**
 * Notify the agent that a job finished. When outputConsumed is true (e.g. a
 * jobs attach already consumed the output) no notification is sent and the job
 * is only cleaned up. The caller calls registry.forget() right after.
 *
 * Completions are coalesced (see notify.ts): a lone finish reads like a single
 * line, but a burst collapses into one summary instead of a wall of notices.
 */
export function notifyFinished(args: {
    job: Job;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): void {
    enqueueFinished(args.reg, args.pi, args.ctx, args.job);
}

/**
 * Record a timeout backgrounding: a lightweight UI toast for the human. Claude
 * Code's behavior on timeout is to silently slide the command into the
 * background — no forced turn, no decision request, no steering message. The
 * bash tool's own "Process backgrounded as job-X" result is the agent's
 * notification that the command moved; a later completion appears as a passive
 * task-notification. We keep only a subtle toast so the human sees something
 * happened. The agent can still use `job_decide` / `jobs` if it wants, but it
 * is never interrupted to do so.
 */
export function requestJobDecision(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    job: Job;
    timeoutMs: number;
}): void {
    args.reg.pendingDecisionJobId = args.job.id;
    const label = `"${jobLabel(args.job)}"`;
    const elapsed = formatDuration(args.timeoutMs);
    args.ctx.ui.notify(`Backgrounded ${label} after ${elapsed}; still running.`, "info");
}

// --- Helpers -------------------------------------------------------------

/** Verify the cwd actually exists. Throws a clear error if not. */
export function requireExistingCwd(cwd: string): void {
    try {
        fsStatSync(cwd);
    } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
}

/** True for whitespace-only commands. bash silently passes empty commands, so reject them explicitly. */
export function isBlankCommand(command: string): boolean {
    return command.trim().length === 0;
}

/**
 * True when the command is eligible for auto-backgrounding. Rejects commands
 * like `sleep` where backgrounding is pointless.
 */
const DISALLOWED_AUTO_BACKGROUND = new Set(["sleep"]);
export function isAutoBackgroundAllowed(command: string): boolean {
    const base = command.trim().split(/\s+/)[0] ?? "";
    return !DISALLOWED_AUTO_BACKGROUND.has(base);
}

/**
 * Actionable guidance shown when a naive `sleep N` wait is blocked. A fixed
 * sleep both wastes time and leaves a lingering background job; every bullet
 * points at a tool that ends as soon as the real work does.
 */
export const SLEEP_WAIT_GUIDANCE =
    "A fixed `sleep N` to wait wastes time and leaves a job lingering for the " +
    "full duration. Instead:\n" +
    "• Waiting on a background job you started? Use jobs action='attach' — it " +
    "returns as soon as that job finishes.\n" +
    "• Waiting for a condition? Use the monitor tool, or a poll loop that EXITS " +
    "when ready (e.g. `until grep -q READY log; do sleep 0.5; done`).\n" +
    "• Just pacing/rate-limiting? Keep it under 2 seconds.";

/** A bare `sleep N[unit]` that counts as a wait (>= 2s). Float durations
 *  (`sleep 0.5`) and sub-2s integer sleeps are deliberate pacing — allowed. */
function detectSleepClause(segment: string): string | null {
    // Allow a trailing `&` — a backgrounded `sleep 600 &` is itself a lingering job.
    const m = /^sleep\s+(\d+)([smhd]?)\s*&?\s*$/.exec(segment);
    if (!m) return null;
    const unit = m[2] || "s";
    if (unit === "s" && parseInt(m[1], 10) < 2) return null;
    return `sleep ${m[1]}${m[2]}`;
}

/**
 * Detect a `sleep N` used as a naive wait — `sleep 600`, `cd x; sleep 600;
 * check`, `build && sleep 5 && test`, `sleep 5m`. Catches it as a top-level
 * step in a flat command sequence (split on top-level `;`, `&&`, `||`).
 *
 * Deliberately conservative around control flow: a `sleep` inside a while/until/
 * for loop is the *correct* polling pattern, and subshells / command
 * substitution make flat splitting unsafe — there we check only the leading
 * command, so a legitimate `until ready; do sleep 1; done` is never flagged.
 *
 * Returns the offending `sleep` clause, or null.
 */
export function detectBlockedSleep(command: string): string | null {
    const trimmed = command.trim();
    // Only an actual loop body can leave a bare `sleep N` segment after a flat
    // split (`do work; sleep 5; done`); an if/case block keeps its `then`/`)`
    // prefix on the sleep, so those don't need special handling. We detect the
    // structural loop pairing (not loose keywords, so `echo done` is fine) and
    // grouping/command-substitution, and fall back to the leading command there.
    const unsafeToSplit =
        /\b(while|until|for)\b[\s\S]*?\bdo\b/.test(trimmed) ||
        /\bdo\b[\s\S]*?\bdone\b/.test(trimmed) ||
        /[(){}`]|\$\(/.test(trimmed);
    // Newline is bash's primary command separator, alongside ; && || — split on
    // all of them so `start-server\nsleep 5\ncurl` is caught like `…; sleep 5; …`.
    const SEPARATORS = /&&|\|\||;|\n/;
    const segments = unsafeToSplit
        ? [trimmed.split(SEPARATORS)[0] ?? ""]
        : trimmed.split(SEPARATORS);
    for (const segment of segments) {
        const clause = detectSleepClause(segment.trim());
        if (clause) return clause;
    }
    return null;
}

// --- Rehydration (session restore) ---------------------------------------

/**
 * Validate a job rehydrated from a serialized session entry. If the PID is
 * dead, force the job to a terminal state.
 */
export function reviveAndValidate(
    _reg: BackgroundRegistry,
    job: Job
): "alive" | "completed" {
    if (job.status !== "running") return "completed";
    // A ws monitor (pid 0) has no process to revive — its socket cannot survive
    // a restart — so it is always terminal. A command monitor falls through to
    // the generic pid-liveness check below: if its child is still alive in this
    // process it stays "running" (killable/inspectable via jobs, though its
    // follower is gone); otherwise it is marked terminal like any dead job.
    if (job.kind === "monitor" && job.pid <= 0) {
        markTerminal(job, "failed");
        return "completed";
    }
    // A job spawned by a *different* pi process (a full restart, not a /reload)
    // cannot be safely managed — the OS may have recycled its PID, and signalling
    // it would hit an unrelated process group. Only revive jobs from the current
    // process. Job ids are `job-<spawning-pid>-<n>`.
    const spawnedPid = Number.parseInt(job.id.split("-")[1] ?? "", 10);
    if (spawnedPid !== process.pid || !processExists(job.pid)) {
        markTerminal(job, "failed");
        return "completed";
    }
    return "alive";
}

// --- Non-interactive mode detection --------------------------------------

/** Detect whether pi is running non-interactively (print / non-TTY). */
export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}

/**
 * Resolve whether the current run is non-interactive, preferring Pi's
 * authoritative UI signal (`ctx.hasUI`) over argv/TTY sniffing.
 *
 * A run is non-interactive exactly when there is no TUI — print/json mode, or a
 * non-TTY stdin pipe. `ctx.hasUI` reflects that directly and is the same signal
 * pi-subagents gates on, so both extensions agree on one definition. It also
 * covers entry paths a bare `-p`/`--print` argv check misses (e.g. `pi --stream`
 * piped from stdin, `--print=true`, or aliases). Falls back to argv/TTY
 * detection only when `hasUI` is unavailable on the context.
 */
export function resolveNonInteractive(
    hasUI: boolean | undefined,
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (typeof hasUI === "boolean") return !hasUI;
    return detectNonInteractive(argv, stdinIsTTY);
}

// --- Cleanup -------------------------------------------------------------

/**
 * Remove background log files older than 24 hours. Scans only the dedicated
 * LOG_DIR (not all of /tmp) and runs off the event loop via fs/promises, so it
 * never blocks session start. Never rejects.
 */
export async function cleanupStaleRuntimeArtifacts(): Promise<void> {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let names: string[];
    try {
        names = await readdir(LOG_DIR);
    } catch {
        return; // dir doesn't exist yet — nothing to clean
    }
    await Promise.all(
        names.map(async (name) => {
            const fullPath = pathJoin(LOG_DIR, name);
            try {
                const { mtimeMs } = await stat(fullPath);
                if (now - mtimeMs > MAX_AGE_MS) await unlink(fullPath);
            } catch {
                /* already gone */
            }
        })
    );
}
