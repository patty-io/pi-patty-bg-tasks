/**
 * Non-interactive turn-end drain.
 *
 * In an interactive session, a background job that finishes after the turn ends
 * surfaces its completion as a notice on a later turn. Non-interactively
 * (`pi -p ...`) the whole task is a single turn: once the model stops, the
 * process exits and `session_shutdown` kills any still-running job (see
 * index.ts) — so work the model started but didn't wait for is lost.
 *
 * To make turn-end consistent with the interactive contract, we block the end
 * of the turn until outstanding jobs finish when there is no next turn. On
 * `agent_end` in a non-interactive session we await every running job's
 * completion promise, so the model no longer has to remember to wait/attach and
 * the shutdown-kill can't discard in-flight work.
 *
 * Bounded by a timeout so a genuinely stuck job can't hang process exit forever.
 */

import { ensureCompletionPromise } from "./lifecycle.ts";
import type { BackgroundRegistry } from "./state.ts";

/** Default cap on how long turn-end will block waiting for jobs to drain. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Await completion of every currently-running background job. No-op when nothing
 * is running. Resolves after all jobs finish or `timeoutMs` elapses, whichever
 * comes first. Never throws.
 */
export async function drainRunningJobs(
    reg: BackgroundRegistry,
    timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS,
): Promise<void> {
    const running = [...reg.jobs.values()].filter((j) => j.status === "running");
    if (running.length === 0) return;

    const promises: Array<Promise<void>> = [];
    for (const job of running) {
        // A running job may not have a completion promise yet (e.g. a foreground
        // command promoted to background); ensure one so we can await it.
        ensureCompletionPromise(job);
        if (job.donePromise) promises.push(job.donePromise);
    }
    if (promises.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        // Do NOT unref: this timer must keep the loop alive alongside the jobs so
        // the turn actually blocks in -p mode.
    });
    try {
        await Promise.race([Promise.all(promises).then(() => undefined), timeout]);
    } catch {
        // Best-effort: never block process exit on a drain error.
    } finally {
        if (timer) clearTimeout(timer);
    }
}
