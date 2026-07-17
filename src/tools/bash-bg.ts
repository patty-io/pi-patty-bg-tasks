// src/tools/bash-bg.ts
//
// `bash_bg` tool — start a bash command in the background immediately.
//
// Unlike the `bash` override, there is no race/timeout/quick-completion
// window. The child runs in the background for its lifetime and
// notifyFinished is invoked on completion. This is a thin wrapper over the
// file-fd spawn backend plus the per-job AbortController + stall watcher.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import { type UiContext } from "../types.ts";
import { spawnWithFileOutput } from "../spawn.ts";
import { add, createRunningJob, nextJobId, logPathFor, renderSidebar } from "../registry.ts";
import {
    assertJobSlot, detectBlockedSleep, isAutoBackgroundAllowed, isBlankCommand,
    requestJobDecision, requireExistingCwd, SLEEP_WAIT_GUIDANCE, startBackgroundJob,
    terminateJobSilently,
} from "../lifecycle.ts";
import { textBlock, backgroundReminder } from "../format.ts";

type BashBgCtx = UiContext & { cwd: string };

export function registerBashBgTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "bash_bg",
        label: "Background Bash",
        description:
            "Start a bash command in the background immediately. " +
            "Output is saved to /tmp/pi-bg/<jobId>.log.",
        promptSnippet: "Start long-running commands directly in the background",
        promptGuidelines: [
            "Use bash_bg when a command should definitely start in the background.",
            "bash_bg gives ONE completion notification. For a per-event stream (tail -f | grep, poll loop, file watch, WebSocket feed), use the monitor tool instead.",
            "Don't background a `sleep N` wait — it just lingers. To wait on an existing job use jobs action='attach'; to wait for a condition use the monitor tool or an `until` loop that exits when ready.",
            "Give the job a name when it will be easier to track in jobs list.",
        ],
        parameters: Type.Object({
            command: Type.String({ description: "Command to run" }),
            name: Type.Optional(Type.String({ description: "Label shown in jobs list" })),
            timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
            notify: Type.Optional(Type.Boolean({ description: "Notify on completion (default: true)" })),
        }),

        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as { command: string; name?: string; timeout?: number; notify?: boolean };
            const ctx2 = ctx as BashBgCtx;
            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            // A backgrounded `sleep N` wait just lingers for the full duration —
            // the lingering-job complaint. Steer to a wait that ends with the work.
            const sleepMatch = detectBlockedSleep(p.command);
            if (sleepMatch) {
                throw new Error(`Blocked: ${sleepMatch}. ${SLEEP_WAIT_GUIDANCE}`);
            }
            requireExistingCwd(ctx2.cwd);
            assertJobSlot(reg);

            const id = nextJobId(reg);
            const logPath = logPathFor(id);
            const spawned = spawnWithFileOutput({
                command: p.command, cwd: ctx2.cwd, logPath,
            });

            const job = createRunningJob({
                id, name: p.name, command: p.command, pid: spawned.pid,
                logPath, toolCallId,
            });
            add(reg, job);
            const jobAc = startBackgroundJob({
                reg, pi, ctx: ctx2, job, exit: spawned.exit,
                shouldNotify: p.notify !== false,
            });

            // Optional timeout — route an overrun into the decision flow.
            if (p.timeout) {
                const timer = setTimeout(() => {
                    if (job.status !== "running" || reg.nonInteractive) return;
                    if (!isAutoBackgroundAllowed(p.command)) {
                        terminateJobSilently(reg, job);
                        renderSidebar(reg, ctx2);
                        return;
                    }
                    requestJobDecision({ reg, pi, ctx: ctx2, job, timeoutMs: p.timeout! * 1000 });
                }, p.timeout * 1000);
                (timer as NodeJS.Timeout).unref();
                jobAc.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
            }

            return {
                content: [textBlock(
                    `Command running in background with ID: ${id}.` +
                    `${p.name ? ` Name: ${p.name}.` : ""} Output is being written to: ${logPath}` +
                    backgroundReminder(reg.nonInteractive)
                )],
                details: undefined,
            };
        },
    });
}
