// src/input.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        // Cooperative steering (Claude Code parity): ANY input typed while a
        // foreground bash command is running backgrounds that command and
        // re-delivers the input as the next turn — regardless of the message's
        // steer/followUp streamingBehavior. We only intercept when a foreground
        // slot is active; everything else falls through to Pi.
        if (reg.foreground.size === 0) return { action: "continue" };
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };

        const text = event.text;
        const bg = backgroundActiveForeground(reg, ctx as UiContext);
        if (!bg) return { action: "continue" };

        // [local patch] Do NOT abort the turn, and deliver as steering.
        //
        // 1. In the TUI, ctx.abort() (upstream 1.1.6) means "cancel like Escape",
        //    not "stop the model": interactive-mode's abortHandler drains
        //    steering+followUp back into the editor *unsent* and only then aborts
        //    the run. Text injected after that drain lands in a run that is already
        //    dying, and agent-loop returns at its error/aborted branch without ever
        //    reaching the follow-up drain.
        // 2. A follow-up is only drained once a turn produces NO tool calls
        //    (agent-loop.js follow-up drain, outside the tool loop). "Delivered
        //    after the current turn settles" therefore means "after the whole
        //    tool-chaining run settles" — measured at 42 turns / 5m29s in one real
        //    session. A steer is drained at the next turn boundary instead.
        //
        // The backgrounding above already makes the bash tool return
        // "Process backgrounded as job-N" inside the same turn, which is what ends
        // the turn, so that boundary arrives immediately.
        try {
            pi.sendUserMessage(text, { deliverAs: "steer" });
        } catch {
            // Session ended between backgrounding and resubmit — nothing to deliver to.
        }

        return { action: "handled" };
    });
}
