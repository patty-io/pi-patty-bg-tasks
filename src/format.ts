/**
 * Formatting helpers — duration strings, status pills, output tails.
 * The completion-notice renderer lives in src/notice.ts; this module is
 * the primitives layer that notice.ts and the rest of the codebase share.
 */
import type { Job } from "./types.ts";
import { PREVIEW_CHARS } from "./types.ts";

/** The standard short label for a job: its name, or its id when unnamed. */
export function jobLabel(job: Job): string {
    return job.name ?? job.id;
}

/** "1m23s" / "45s" / "0s" — short human-readable duration. */
export function formatDuration(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

/** Human-readable status pill, including duration for running jobs. */
export function statusLabel(job: Job, duration?: string): string {
    const dur = duration ?? formatDuration(Date.now() - job.startTime);
    switch (job.status) {
        case "running":
            if (job.kind === "monitor") return `◉ monitor (${dur})`;
            return job.isBackgrounded ? `▶ bg (${dur})` : `▶ fg (${dur})`;
        case "completed":
            return "✓ completed";
        case "failed":
            return "✗ failed";
        case "killed":
            return "✗ killed";
    }
}

/** "job-123-5: ls -la (last 80 chars)" — single line for `jobs list`. */
export function formatJobLine(job: Job): string {
    const head = job.name ? `${job.name} (${job.id})` : job.id;
    const duration =
        job.status === "running"
            ? ` (${formatDuration(Date.now() - job.startTime)})`
            : "";
    return `${head}: ${job.command.slice(0, PREVIEW_CHARS.line)} - ${statusLabel(job)}${duration}`;
}

/** Truncate a tail with a consistent "showing last N chars" marker. */
export function truncateTail(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return `...[truncated, showing last ${maxChars} chars]\n${content.slice(-maxChars)}`;
}

/** Text content block builder — shared across all tools. The explicit return
 *  type documents the shared contract for the five tool call sites that
 *  import this — they rely on the literal shape, not inference. */
export function textBlock(s: string): { type: "text"; text: string } {
    return { type: "text" as const, text: s };
}

/**
 * Model-facing reminder appended to every "started/moved to background" message,
 * so the model knows how to retrieve the result instead of assuming the command
 * is done. Mirrors pi-subagents' async reminder, but for background OS jobs.
 *
 * The non-interactive caveat matters: in `pi -p ...` there is no next turn to
 * surface a completion notice, so the model must actively wait/attach or the
 * result is never observed. (patty also drains outstanding jobs at turn-end in
 * non-interactive mode, but the model should still collect output it needs.)
 */
export function backgroundReminder(nonInteractive: boolean): string {
    const lines = [
        "",
        "This job runs detached — the command is NOT finished yet. Do not assume its result.",
        "Do not run sleep timers or polling loops to wait for it. Instead:",
        "• Need its output/exit before continuing? Use jobs action='attach' (blocks until this job ends), or wait() to block on the next background job to finish.",
        "• Want to see progress as it streams? Use the monitor tool, or jobs action='output' for a non-blocking peek.",
        "• Check status any time with jobs action='list'.",
    ];
    if (nonInteractive) {
        lines.push(
            "You are in a non-interactive run: there is no next turn to deliver this job's completion. If you need its result, call wait() (or jobs action='attach') now — otherwise the turn will end and you'll never see the output.",
        );
    } else {
        lines.push(
            "When the job finishes, its completion will surface on a later turn; if you need the result before replying, wait()/attach now rather than stopping.",
        );
    }
    return lines.join("\n");
}
