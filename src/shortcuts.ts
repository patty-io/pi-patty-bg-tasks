/**
 * Keyboard shortcut registration.
 *
 *   - Ctrl+B: background foreground commands when the editor is empty;
 *     otherwise retain pi's built-in cursor-left behavior
 *   - Ctrl+Shift+B: move the foreground bash to background
 *   - Ctrl+Shift+J / Shift+Down: open the background task manager
 *   - Ctrl+Shift+X: kill the most recent running job
 *
 * Ctrl+B is handled by a CustomEditor instead of registerShortcut(). Extension
 * shortcuts consume matching input before the editor sees it, so they cannot
 * conditionally fall back to `tui.editor.cursorLeft` without moving the cursor
 * logic into the extension.
 */

import {
    CustomEditor,
    type ExtensionAPI,
    type ExtensionContext,
    type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { BackgroundRegistry } from "./state.ts";
import { takeControl, terminateJobSilently } from "./lifecycle.ts";
import { renderSidebar } from "./registry.ts";
import { jobLabel } from "./format.ts";
import { openBgListPanel } from "./ui.ts";

/** Editor that shares Ctrl+B with pi's built-in cursor-left binding. */
export class BackgroundTaskEditor extends CustomEditor {
    private readonly onEmptyCtrlB: () => void;

    constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
        onEmptyCtrlB: () => void
    ) {
        super(tui, theme, keybindings);
        this.onEmptyCtrlB = onEmptyCtrlB;
    }

    override handleInput(data: string): void {
        if (matchesKey(data, "ctrl+b") && this.getText().length === 0) {
            this.onEmptyCtrlB();
            return;
        }
        super.handleInput(data);
    }
}

/** Register all shortcuts. */
export function registerShortcuts(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    // Intercept Ctrl+B before CustomEditor's extension-shortcut dispatch only
    // when there is no input to edit. All other input follows pi's normal path.
    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        ctx.ui.setEditorComponent(
            (tui, theme, keybindings) =>
                new BackgroundTaskEditor(tui, theme, keybindings, () =>
                    handleCtrlB(reg, ctx)
                )
        );
    });

    // Ctrl+Shift+B remains available regardless of editor contents.
    pi.registerShortcut("ctrl+shift+b", {
        description: "Background the current foreground process",
        handler: async (ctx) => handleCtrlB(reg, ctx),
    });

    pi.registerShortcut("ctrl+shift+j", {
        description: "Open background task manager",
        handler: async (ctx) => openBgListPanel(reg, ctx),
    });

    pi.registerShortcut("shift+down", {
        description: "Open background task manager",
        handler: async (ctx) => openBgListPanel(reg, ctx),
    });

    pi.registerShortcut("ctrl+shift+x", {
        description: "Kill the most recent running background job",
        handler: async (ctx) => handleCtrlX(reg, ctx),
    });
}

/**
 * Ctrl+B / Ctrl+Shift+B / `/bg` handler — background ALL running foreground
 * commands (Claude Code's `backgroundAll`). takeControl deliberately never aborts the
 * turn: the bash tool returns its "backgrounded" result, the turn ends, and a
 * queued user message drains at the natural turn boundary. See
 * lifecycle.takeControl.
 */
function handleCtrlB(reg: BackgroundRegistry, ctx: ExtensionContext): void {
    takeControl(reg, ctx);
}

/** Ctrl+Shift+X: kill the most recent running job. */
async function handleCtrlX(
    reg: BackgroundRegistry,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>>[0]
): Promise<void> {
    const running = Array.from(reg.jobs.values())
        .filter((j) => j.status === "running")
        .sort((a, b) => b.startTime - a.startTime);

    if (running.length === 0) {
        ctx.ui.notify("No running tasks to kill", "warning");
        return;
    }

    const target = running[0];
    terminateJobSilently(reg, target);
    renderSidebar(reg, ctx);
    ctx.ui.notify(`Killed ${jobLabel(target)}`, "info");
}
