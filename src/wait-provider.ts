/**
 * Register pi-patty-bg-tasks as a background-work provider for a `wait` tool.
 *
 * A `wait` tool (e.g. pi-subagents') blocks the current turn until outstanding
 * background work finishes. It discovers work through pi-subagents'
 * process-global v1 provider registry: any extension can publish exact,
 * session-scoped work identities plus wake channels and a reconcile hook.
 *
 * This is dependency-free — no import between the packages, just the same
 * versioned Symbol.for registry used by pi-subagents/background-work — so patty
 * still loads normally when pi-subagents is not installed.
 */

import { BG_TASK_FINISHED_EVENT } from "./types.ts";
import { reconcileJobs } from "./reconcile.ts";
import type { BackgroundRegistry } from "./state.ts";

/** Must match pi-subagents/background-work. */
const BACKGROUND_WORK_PROTOCOL_VERSION = 1;
const REGISTRY_KEY = "pi-subagents.background-work.v1";

interface BackgroundWorkItem {
    id: string;
    sessionId: string;
}

interface BackgroundWorkReconcileContext {
    sessionId: string;
    nowMs: number;
}

interface BackgroundWorkProvider {
    name: string;
    listActiveWork(): readonly BackgroundWorkItem[];
    wakeChannels?: readonly string[];
    reconcile?(context: BackgroundWorkReconcileContext): void;
}

interface BackgroundWorkRegistry {
    version: typeof BACKGROUND_WORK_PROTOCOL_VERSION;
    providers: Map<string, BackgroundWorkProvider>;
}

function registry(): BackgroundWorkRegistry {
    const key = Symbol.for(REGISTRY_KEY);
    const g = globalThis as Record<PropertyKey, unknown>;
    const existing = g[key];
    if (existing === undefined) {
        const created: BackgroundWorkRegistry = {
            version: BACKGROUND_WORK_PROTOCOL_VERSION,
            providers: new Map(),
        };
        g[key] = created;
        return created;
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error(`Malformed background-work registry at Symbol.for("${REGISTRY_KEY}").`);
    }
    const candidate = existing as Partial<BackgroundWorkRegistry>;
    if (candidate.version !== BACKGROUND_WORK_PROTOCOL_VERSION || !(candidate.providers instanceof Map)) {
        throw new Error(`Unsupported background-work registry at Symbol.for("${REGISTRY_KEY}").`);
    }
    return candidate as BackgroundWorkRegistry;
}

/**
 * Publish patty's provider on the shared registry. Replaces any older provider
 * with the same name, and the returned disposer only removes this exact
 * registration so extension reloads cannot unregister their replacement. Safe
 * to call even if no `wait` tool is installed.
 *
 * The provider also supplies a `reconcile()` health check (see reconcile.ts):
 * on each of wait's poll ticks it finalizes jobs whose process has died and
 * kills jobs that are alive but wedged (no output past a stale window), so a
 * `wait` tool never blocks forever on a background job that will never finish.
 */
export function registerWaitProvider(reg: BackgroundRegistry): () => void {
    const provider: BackgroundWorkProvider = {
        name: "pi-patty-bg-tasks",
        listActiveWork: () =>
            [...reg.jobs.values()]
                .filter((job) => job.status === "running" && typeof job.sessionId === "string" && job.sessionId.length > 0)
                .map((job) => ({ id: job.id, sessionId: job.sessionId! })),
        wakeChannels: [BG_TASK_FINISHED_EVENT],
        reconcile: ({ sessionId, nowMs }) => reconcileJobs(reg, {
            now: () => nowMs,
            shouldReconcile: (job) => job.sessionId === sessionId,
        }),
    };
    const store = registry();
    store.providers.set(provider.name, provider);
    return () => {
        if (store.providers.get(provider.name) === provider) store.providers.delete(provider.name);
    };
}
