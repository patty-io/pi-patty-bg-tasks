/**
 * pi-patty-bg-tasks — background task extension for the pi agent.
 *
 * Registers six tools:
 *   - bash (override)
 *   - bash_bg
 *   - jobs
 *   - job_decide
 *   - agent_bg
 *   - monitor (streaming-event watch)
 *
 * Also registers keyboard shortcuts and slash commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry } from "./state.ts";
import {
    cleanupStaleRuntimeArtifacts,
    detectNonInteractive,
    reviveAndValidate,
    terminateJobSilently,
} from "./lifecycle.ts";
import { forget as forgetJob, stopSidebarTicker } from "./registry.ts";
import { cancelPendingNotices, noteAgentEnd, noteAgentStart } from "./notify.ts";
import {
    EVENT,
    PERSISTED_STATE_SCHEMA_VERSION,
    type Job,
    type UiContext,
} from "./types.ts";
import { registerBashBgTool } from "./tools/bash-bg.ts";
import { registerJobsTool } from "./tools/jobs.ts";
import { registerJobDecideTool } from "./tools/job-decide.ts";
import { registerAgentBgTool } from "./tools/agent-bg.ts";
import { registerMonitorTool } from "./tools/monitor.ts";
import { registerShortcuts } from "./shortcuts.ts";
import { registerCommands } from "./commands.ts";
import { registerInputHandlers } from "./input.ts";
import { patchBashExecute } from "./defer-bash.ts";

interface PersistedState {
    schemaVersion?: number;
    jobs?: Array<[string, Omit<Job, "proc" | "donePromise" | "resolveDone">]>;
    jobCounter?: number;
}

/** Extension entry point. */
export default function (pi: ExtensionAPI): void {
    const reg = new BackgroundRegistry();

    // ── Tool registration ─────────────────────────────────────────
    // NOTE: bash tool is NOT registered here to avoid init-time conflict with
    // display extensions (pi-tool-display, etc.) that also register a tool
    // named "bash". Instead, bash execute is patched in-place via prototype
    // monkey-patch on ExtensionRunner (see defer-bash.ts).
    // The patch runs when the tool registry is first built in
    // AgentSession._buildRuntime, giving us our backgrounding-aware execute
    // while preserving whatever renderCall/renderResult another extension provides.
    patchBashExecute(reg, pi);
    registerBashBgTool(pi, reg);
    registerJobsTool(pi, reg);
    registerJobDecideTool(pi, reg);
    registerAgentBgTool(pi, reg);
    registerMonitorTool(pi, reg);

    // ── Shortcuts / commands ──────────────────────────────────────
    registerShortcuts(pi, reg);
    registerCommands(pi, reg);
    registerInputHandlers(pi, reg);

    // ── Turn boundaries ───────────────────────────────────────────
    // Hold background notices while the agent is mid-turn and flush them as ONE
    // summary when the turn ends — so a long turn full of finishing jobs/monitors
    // collapses into a single line instead of a wall dumped after the reply.
    pi.on("agent_start", async (_event, ctx) => {
        noteAgentStart(reg, pi, ctx as unknown as UiContext);
    });
    pi.on("agent_end", async (_event, ctx) => {
        noteAgentEnd(reg, pi, ctx as unknown as UiContext);
    });

    // ── Session start ─────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );

        // Restore serialized background job state.
        const entries = ctx.sessionManager.getEntries();
        const stateEntries = entries.filter(
            (e) =>
                e.type === "custom" &&
                (e as { customType?: string }).customType === EVENT.state
        ) as Array<{ type: "custom"; customType: string; data: unknown }>;

        // Restore from the latest valid snapshot only. session_shutdown appends
        // a fresh snapshot every time; replaying them all (last-write-wins with
        // side effects) can resurrect phantom "running" jobs that a newer
        // snapshot already dropped, and double-counts terminal jobs.
        const latest = [...stateEntries]
            .reverse()
            .map((e) => e.data as PersistedState)
            .find((d) => d.schemaVersion === PERSISTED_STATE_SCHEMA_VERSION);

        if (latest) {
            if (latest.jobs) {
                for (const [id, job] of latest.jobs) {
                    reviveAndValidate(reg, job);
                    if (job.status !== "running") {
                        // Not alive — fold into the counter and drop from the map.
                        forgetJob(reg, job);
                    } else {
                        reg.jobs.set(id, job);
                    }
                }
            }
            if (typeof latest.jobCounter === "number") {
                reg.counter = Math.max(reg.counter, latest.jobCounter);
            }
        }

        void cleanupStaleRuntimeArtifacts();
    });

    // ── Session shutdown ──────────────────────────────────────────
    pi.on("session_shutdown", async (event, _ctx) => {
        // Stop the live-duration ticker so the interval doesn't outlive the session.
        stopSidebarTicker(reg);
        // Drop any open completion-coalescing window (its notice would never render).
        cancelPendingNotices(reg);

        // On quit, kill all running background jobs to avoid orphans.
        if (event.reason === "quit") {
            for (const job of reg.jobs.values()) {
                if (job.status === "running") {
                    terminateJobSilently(reg, job);
                }
            }
        }

        pi.appendEntry(EVENT.state, {
            schemaVersion: PERSISTED_STATE_SCHEMA_VERSION,
            jobs: Array.from(reg.jobs.entries()).map(([id, job]) => [
                id,
                {
                    ...job,
                    proc: undefined,
                    donePromise: undefined,
                    resolveDone: undefined,
                    stop: undefined,
                },
            ]),
            jobCounter: reg.counter,
        });
    });
}
