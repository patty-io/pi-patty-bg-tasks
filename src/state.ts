/**
 * Shared mutable state for the background-tasks extension.
 *
 * One instance per session, threaded through every tool and helper.
 */

import type { Job, ForegroundSlot, MonitorEnd } from "./types.ts";

export class BackgroundRegistry {
    jobs = new Map<string, Job>();
    currentSessionId: string | undefined;
    foreground = new Map<string, ForegroundSlot>();
    counter = 0;
    activeToolCallId: string | null = null;
    pendingDecisionJobId: string | undefined;

    /** Per-job AbortController — abort() cancels all monitors/pollers for that job. */
    jobAborts = new Map<string, AbortController>();

    nonInteractive = false;

    completedCount = 0;
    failedCount = 0;
    totalStarted = 0;
    totalDurationMs = 0;
    recentTerminal: Job[] = [];

    /** Live-duration ticker for the sidebar pills; runs while jobs are alive. */
    sidebarTimer: NodeJS.Timeout | undefined = undefined;
    /** Last rendered sidebar content — used to skip redundant widget updates. */
    lastSidebarContent: string | undefined = undefined;

    /** Finished jobs + monitor terminals awaiting a coalesced notice (notify.ts).
     *  Buffered so a whole turn's worth of finishes surfaces as one summary, not
     *  a wall dumped after the agent's reply. */
    pendingFinished: Job[] = [];
    pendingMonitorEnds: MonitorEnd[] = [];
    /** True while the agent is mid-turn (between agent_start and agent_end).
     *  Notices flush at agent_end then, not on the idle fallback timer. */
    agentBusy = false;
    /** Idle-only coalescing fallback timer (armed only when the agent is idle). */
    noticeFlushTimer: NodeJS.Timeout | undefined = undefined;
}
