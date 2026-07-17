/**
 * Cross-extension live-job registry, published on `globalThis`.
 *
 * pi-patty-bg-tasks and other extensions (e.g. a `wait` tool) run in the SAME
 * Node process, so a process-global set is a reliable, dependency-free channel
 * for another extension to learn which background jobs are currently in flight —
 * something the private per-session BackgroundRegistry can't provide across
 * extension boundaries.
 *
 * This tracks only liveness (a set of running job ids). Rich per-completion data
 * still travels on the BG_TASK_FINISHED_EVENT bus event. A `wait` tool combines
 * the two: read the set to know how many jobs are outstanding when the wait
 * begins, subscribe to the event to wake the instant one finishes.
 *
 * Keyed by a versioned symbol so multiple loaded copies of this module (e.g. an
 * extension reload) share one set instead of each getting its own.
 */

const KEY = "__pi_patty_bg_live_jobs_v1";

type GlobalWithLive = typeof globalThis & { [KEY]?: Set<string> };

function store(): Set<string> {
    const g = globalThis as GlobalWithLive;
    let set = g[KEY];
    if (!set) {
        set = new Set<string>();
        g[KEY] = set;
    }
    return set;
}

/** Mark a background job id as live (called when a job starts). */
export function markLive(jobId: string): void {
    store().add(jobId);
}

/** Mark a background job id as no longer live (called on terminal completion). */
export function clearLive(jobId: string): void {
    store().delete(jobId);
}

/** Current count of in-flight background jobs across the process. */
export function liveJobCount(): number {
    return store().size;
}

/** Snapshot of in-flight background job ids. */
export function liveJobIds(): string[] {
    return [...store()];
}
