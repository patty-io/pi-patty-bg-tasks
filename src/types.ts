/**
 * Type definitions and shared constants for the background-tasks extension.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const PERSISTED_STATE_SCHEMA_VERSION = 2;

// --- Configuration constants ---
export const DEFAULT_TIMEOUT_MS = 120_000;
export const QUICK_COMPLETION_MS = 2_000;
export const FOREGROUND_TAIL_BYTES = 4_096;
export const STALL_CHECK_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1024;
export const MAX_LOG_BYTES = 100 * 1024 * 1024;
export const OUTPUT_PREVIEW_CHARS = 12_000;
export const RECENT_TERMINAL_KEEP = 20;
export const MAX_CONCURRENT_JOBS = 16;
/** Coalescing window for background-job completion notices. Completions within
 *  this window collapse into one summary message instead of one line each, so a
 *  burst of finished jobs doesn't dump a wall of `[job-finished]` lines. Kept
 *  sub-second so a lone job's notice isn't perceptibly delayed; jobs launched
 *  together still finish within tens of ms of each other and coalesce. */
export const JOB_FINISH_COALESCE_MS = 400;

// --- Monitor (streaming-event) constants ---
/** Poll cadence for the line-accurate follower. Lines read within one tick are
 *  batched into a single event — so this doubles as the ~200ms batch window. */
export const MONITOR_POLL_MS = 200;
/** Default streaming watch deadline (matches Claude Code's Monitor). */
export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
/** Hard ceiling on a monitor's deadline. */
export const MONITOR_MAX_TIMEOUT_MS = 3_600_000;
/** Sliding window for firehose detection. */
export const MONITOR_RATE_WINDOW_MS = 10_000;
/** Max emitted lines per window before a monitor is auto-stopped. */
export const MONITOR_MAX_LINES_PER_WINDOW = 500;

export const PREVIEW_CHARS = {
    sidebar: 25,
    taskList: 40,
    detail: 50,
    line: 80,
    /** Live progress line shown in the sidebar pill. */
    progress: 60,
} as const;

// --- Domain types ---
export type JobStatus = "running" | "completed" | "failed" | "killed";

/** What kind of background job this is. "shell" is the default (bash/bash_bg/
 *  bash_bg); "monitor" is a streaming-event watch (the monitor tool). */
export type JobKind = "shell" | "monitor";

export interface Job {
    id: string;
    /** Pi session identity that owns this background job. */
    sessionId?: string;
    name?: string;
    command: string;
    pid: number;
    startTime: number;
    status: JobStatus;
    exitCode?: number;
    logPath: string;
    proc?: ChildProcess;
    toolCallId: string;
    donePromise?: Promise<void>;
    resolveDone?: () => void;
    outputConsumed?: boolean;
    isBackgrounded: boolean;
    /** Defaults to "shell" when absent (back-compat with persisted jobs). */
    kind?: JobKind;
    /** Transient teardown hook (follower + ws socket). Never persisted. */
    stop?: () => void;
    /** Wall-clock finish time, stamped when queued for a completion notice so a
     *  coalesced notice reports the true duration, not the flush time. */
    endedAt?: number;
}

export type BackgroundReason = "manual" | "timeout";

/** A monitor's terminal notice (stream ended / stopped / failed), coalesced
 *  with job completions into one turn-boundary summary. */
export interface MonitorEnd {
    description: string;
    summary: string;
    failed: boolean;
}

/** Transient handle for an in-flight foreground bash command, keyed by
 *  toolCallId in the registry. Ctrl+Shift+B and the timeout timer call
 *  requestPause to flip the command into the background. */
export interface ForegroundSlot {
    requestPause: (reason: BackgroundReason) => void;
}

// --- Event types ---
export const EVENT = {
    state: "background-tasks-state",
    stall: "bg-stall",
    timeout: "bg-timeout",
    attach: "bg-attach",
    background: "bg-manual",
    agentResume: "agent-resume",
    jobFinished: "job-finished",
    monitorEvent: "bg-monitor-event",
} as const;

/**
 * pi.events bus channel emitted the instant a background job reaches a terminal
 * state (completeJob), independent of the coalesced turn-boundary user notice.
 * Other extensions (e.g. a `wait` tool) can subscribe to react in real time to
 * a background bash/agent job finishing. Payload: BgTaskFinishedEvent.
 */
export const BG_TASK_FINISHED_EVENT = "patty:bg-task-finished";

/** Payload emitted on BG_TASK_FINISHED_EVENT. */
export interface BgTaskFinishedEvent {
    jobId: string;
    name?: string;
    command: string;
    status: JobStatus;
    exitCode?: number;
    pid: number;
    kind: JobKind;
    logPath: string;
    startTime: number;
    endedAt: number;
}

export type EventName = (typeof EVENT)[keyof typeof EVENT];

// --- Deliver options ---
/** Steer the message into the current/next turn AND wake the agent.
 *  Use when the message IS the answer to a question the agent must address
 *  now (a finished background job while idle, a deadline decision). */
export const DELIVER_STEER = { deliverAs: "steer", triggerTurn: true } as const;
/** Queue the message behind the current turn as a PASSIVE follow-up. The agent
 *  picks it up on its next natural turn (when the user re-engages or the
 *  current turn ends) but it does NOT spawn a new turn on its own. This mirrors
 *  Claude Code's `priority: 'later'` task-notification delivery: completions,
 *  background notices, and monitor stream events are informational and never
 *  force an unsolicited acknowledgment or starve user input.
 *  NOTE: sendMessage-only — `pi.sendUserMessage` rejects `triggerTurn` and
 *  takes just `{ deliverAs: "followUp" }`. */
export const DELIVER_FOLLOWUP = { deliverAs: "followUp", triggerTurn: false } as const;

// --- UI context ---
export interface UiContext {
    ui: {
        notify(message: string, level?: "info" | "warning" | "error"): void;
        setWidget(
            name: string,
            content: string[] | undefined,
            options?: { placement?: "aboveEditor" | "belowEditor" }
        ): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
        select(title: string, options: string[]): Promise<string | undefined>;
        editor(title: string, content: string): Promise<string | undefined>;
    };
}

export type ToolResult = AgentToolResult<unknown>;
