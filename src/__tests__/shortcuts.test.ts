import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BackgroundTaskEditor, registerShortcuts } from "../shortcuts.ts";
import { BackgroundRegistry } from "../state.ts";
import { takeControl } from "../lifecycle.ts";

const CTRL_B = "\x02";

function makeEditor(text: string) {
    const reg = new BackgroundRegistry();
    const notices: string[] = [];
    let pauseCount = 0;
    reg.foreground.set("tool-1", {
        requestPause: () => {
            pauseCount++;
        },
    });

    const ctx = {
        ui: {
            notify: (message: string) => notices.push(message),
            setWidget() {},
            setStatus() {},
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    } as unknown as ExtensionContext;
    const editor = new BackgroundTaskEditor(
        { requestRender() {} } as never,
        { borderColor: (value: string) => value } as never,
        { matches: () => false } as never,
        () => takeControl(reg, ctx)
    );
    editor.setText(text);

    return { editor, notices, pauseCount: () => pauseCount };
}

void describe("BackgroundTaskEditor — conditional Ctrl+B", () => {
    void it("backgrounds foreground commands when the editor is empty", () => {
        const h = makeEditor("");

        h.editor.handleInput(CTRL_B);

        assert.equal(h.pauseCount(), 1);
        assert.deepEqual(h.notices, ["▶ Backgrounded — continuing."]);
    });

    void it("keeps pi's cursor-left behavior when the editor has input", () => {
        const h = makeEditor("ab");
        assert.deepEqual(h.editor.getCursor(), { line: 0, col: 2 });

        h.editor.handleInput(CTRL_B);

        assert.deepEqual(h.editor.getCursor(), { line: 0, col: 1 });
        assert.equal(h.pauseCount(), 0, "the extension action must not run");
        assert.deepEqual(h.notices, []);
    });
});

void describe("registerShortcuts — Ctrl+B integration", () => {
    void it("uses a session editor instead of registering a conflicting shortcut", () => {
        const registered: string[] = [];
        let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
        const pi = {
            registerShortcut(shortcut: string) {
                registered.push(shortcut);
            },
            on(event: string, handler: typeof sessionStart) {
                if (event === "session_start") sessionStart = handler;
            },
        };

        registerShortcuts(pi as never, new BackgroundRegistry());

        assert.deepEqual(registered, [
            "ctrl+shift+b",
            "ctrl+shift+j",
            "shift+down",
            "ctrl+shift+x",
        ]);
        assert.equal(typeof sessionStart, "function");

        let editorFactory: unknown;
        sessionStart!({}, {
            mode: "tui",
            ui: {
                setEditorComponent(factory: unknown) {
                    editorFactory = factory;
                },
            },
        });
        assert.equal(typeof editorFactory, "function");
    });
});
