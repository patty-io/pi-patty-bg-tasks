/**
 * pi-patty-bg-tasks — background task extension for the pi agent.
 *
 * Registers five tools:
 *   - bash (override)
 *   - bash_bg
 *   - jobs
 *   - agent_bg
 *   - monitor (streaming-event watch)
 *
 * Also registers keyboard shortcuts and slash commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry } from "./state.ts";
import { detectNonInteractive, terminateJobSilently } from "./lifecycle.ts";
import { stopSidebarTicker } from "./registry.ts";
import { EVENT } from "./types.ts";
import { registerBashTool } from "./tools/bash.ts";
import { registerBashBgTool } from "./tools/bash-bg.ts";
import { registerJobsTool } from "./tools/jobs.ts";
import { registerAgentBgTool } from "./tools/agent-bg.ts";
import { registerMonitorTool } from "./tools/monitor.ts";
import { registerShortcuts } from "./shortcuts.ts";
import { registerCommands } from "./commands.ts";
import { registerInputHandlers } from "./input.ts";
import { shouldRegisterBashOverride } from "./subagent.ts";

/** Extension entry point. */
export default function (pi: ExtensionAPI): void {
    const reg = new BackgroundRegistry();

    // ── Tool registration ─────────────────────────────────────────
    // Use the unwrapped tool *definition* so the override inherits Pi's native
    // bash renderCall/renderResult (createBashTool returns a wrapped AgentTool
    // that drops them).
    const originalBash = createBashToolDefinition(process.cwd());
    if (shouldRegisterBashOverride()) {
        registerBashTool(pi, reg, originalBash);
    }
    registerBashBgTool(pi, reg);
    registerJobsTool(pi, reg);
    registerAgentBgTool(pi, reg);
    registerMonitorTool(pi, reg);

    // ── Shortcuts / commands ──────────────────────────────────────
    registerShortcuts(pi, reg);
    registerCommands(pi, reg);
    registerInputHandlers(pi, reg);

    // ── Message rendering ─────────────────────────────────────────
    // <task-notification> messages render as one colored line: green for
    // completed, red for failed, yellow for killed and for the statusless
    // stall warning (CC's unread/attention color).
    const renderTaskNotification = (
        message: { content: unknown; details?: unknown },
        theme: { fg(colour: string, text: string): string }
    ) => {
        const details = message.details as
            | { status?: string; summary?: string }
            | undefined;
        const colour =
            details?.status === "completed"
                ? "success"
                : details?.status === "failed"
                  ? "error"
                  : "warning";
        const line = theme.fg(colour, `● ${details?.summary ?? String(message.content)}`);
        return { render: () => [line], invalidate: () => {} };
    };
    pi.registerMessageRenderer(EVENT.taskNotification, (message, _options, theme) =>
        renderTaskNotification(message, theme)
    );
    pi.registerMessageRenderer(EVENT.stall, (message, _options, theme) =>
        renderTaskNotification(message, theme)
    );

    // ── Session start ─────────────────────────────────────────────
    // Claude Code parity: the registry is purely in-memory — no persistence,
    // no revival. Every session starts with an empty registry.
    pi.on("session_start", async (_event, _ctx) => {
        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );
    });

    // ── Session shutdown ──────────────────────────────────────────
    pi.on("session_shutdown", async (_event, _ctx) => {
        // Stop the live-duration ticker so the interval doesn't outlive the session.
        stopSidebarTicker(reg);

        // Claude Code's gracefulShutdown: kill ALL running tasks on ANY
        // shutdown reason, so no orphans outlive the session. The silent-kill
        // path latches `notified`, so no <task-notification> fires on the way
        // out. Log files are left for the OS to clean.
        for (const job of reg.jobs.values()) {
            if (job.status === "running") {
                terminateJobSilently(reg, job);
            }
        }
    });
}
