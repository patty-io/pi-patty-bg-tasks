/**
 * Health check for background jobs, run by a `wait` tool on each poll tick via
 * the provider registry's optional `reconcile()` hook.
 *
 * Job completion is normally driven by the child's exit callback (completeJob).
 * But a background child can leave a job stuck "running" forever in two ways a
 * `wait` tool would otherwise block on indefinitely:
 *
 *   1. Its process is GONE but the exit callback never fired (missed close
 *      event, killed out-of-band, crashed host). PID probe says dead → we mark
 *      the job terminal so it leaves the live set.
 *
 *   2. Its process is ALIVE but WEDGED — producing no output for a long time
 *      (e.g. a nested `pi` child hung in its event loop waiting on a request
 *      that never returns). No exit will ever come. Past a generous staleness
 *      threshold we terminate it so wait can make progress.
 *
 * This mirrors how pi-subagents reconciles detached async runs (PID liveness +
 * staleness), but for patty's own jobs. Conservative by design: dead-PID cleanup
 * is always safe; the alive-but-stale kill only triggers after a long no-output
 * window so normal quiet work (a slow compile, a long download) is never killed.
 */

import { statSync } from "node:fs";
import type { BackgroundRegistry } from "./state.ts";
import type { Job } from "./types.ts";
import { processExists } from "./spawn.ts";
import { terminateJobSilently } from "./lifecycle.ts";

/** No-output window after which an alive-but-silent job is considered wedged. */
export const DEFAULT_STALE_JOB_MS = 10 * 60 * 1000; // 10 minutes

export interface ReconcileDeps {
    /** Now, injectable for tests. */
    now?: () => number;
    /** Stale-output threshold; injectable for tests. */
    staleMs?: number;
    /** PID liveness probe; injectable for tests. Defaults to processExists. */
    isAlive?: (pid: number | undefined) => boolean;
    /** Last-output-activity timestamp for a job; injectable for tests. */
    lastActivityMs?: (job: Job) => number;
    /** Optional job filter, used by provider-scoped reconciliation. */
    shouldReconcile?: (job: Job) => boolean;
}

/**
 * Reconcile every running job's health. Terminal transitions go through
 * terminateJobSilently, which clears the job from the cross-extension live set
 * and resolves its completion promise (via markTerminal) — so a `wait` tool
 * blocked on it makes progress. It needs no UI context, so this is safe to call
 * from wait's poll loop where none is available. Never throws.
 */
export function reconcileJobs(
    reg: BackgroundRegistry,
    deps: ReconcileDeps = {},
): void {
    const now = deps.now?.() ?? Date.now();
    const staleMs = deps.staleMs ?? DEFAULT_STALE_JOB_MS;
    const isAlive = deps.isAlive ?? processExists;
    const lastActivity = deps.lastActivityMs ?? defaultLastActivity;

    // Snapshot: termination mutates the map.
    const running = [...reg.jobs.values()].filter((j) =>
        j.status === "running" && (deps.shouldReconcile?.(j) ?? true)
    );
    for (const job of running) {
        // Monitors are long-lived by design (they tail a stream); never treat a
        // quiet monitor as wedged.
        if (job.kind === "monitor") continue;

        // 1) Process gone but never reported exit → finalize it.
        // 2) Alive but no output past the stale window → wedged; kill it so its
        //    completion fires (a child that will never exit on its own).
        const dead = !isAlive(job.pid);
        const wedged = now - lastActivity(job) >= staleMs;
        if (dead || wedged) {
            try {
                terminateJobSilently(reg, job);
            } catch {
                /* best-effort */
            }
        }
    }
}

/** Default activity clock: newest of the job's log mtime and its start time. */
function defaultLastActivity(job: Job): number {
    let mtime = 0;
    try {
        mtime = statSync(job.logPath).mtimeMs;
    } catch {
        // Log may not exist yet; fall back to start time.
    }
    return Math.max(mtime, job.startTime);
}
