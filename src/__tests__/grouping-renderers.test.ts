/**
 * Renderer-wiring tests for grouped shell rows.
 *
 * The state machine is covered by grouping.test.ts; these tests drive the real
 * renderers registered on the bash tool, because the sharp edges live in the
 * wiring, not the state:
 *   - pi hands renderResult `{content, details}` and keeps the error flag on the
 *     context, so reading `result.isError` silently renders failures as ✓
 *   - only the turn's first row may render; the rest must render zero lines
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerBashTool } from "../tools/bash.ts";
import { BackgroundRegistry } from "../state.ts";
import { createGroupedShellRenderers } from "../grouping.ts";

type Rendered = { render(width: number): string[] };

interface CapturedTool {
    name: string;
    renderShell?: string;
    renderCall?: unknown;
}

const theme = {
    fg: (_colour: string, text: string) => text,
    bold: (text: string) => text,
};

/** The renderers as the tool registers them, with no env or registry involved. */
interface FakePi {
    on(event: string, handler: (event?: unknown) => void): undefined;
}

/** A stand-in pi that records the handlers grouping registers, by event name. */
function fakePi(handlers?: Map<string, (event?: unknown) => void>): never {
    return {
        on: (event: string, handler: (event?: unknown) => void) => {
            handlers?.set(event, handler);
            return undefined;
        },
    } as never;
}

function renderers() {
    return createGroupedShellRenderers(fakePi());
}

function call(
    renderer: ReturnType<typeof renderers>,
    toolCallId: string,
    command: string,
    expanded = false
): Rendered {
    return renderer.renderCall({ command }, theme, {
        toolCallId,
        expanded,
        invalidate() {},
    }) as Rendered;
}

function result(
    renderer: ReturnType<typeof renderers>,
    toolCallId: string,
    text: string,
    isError: boolean
): Rendered {
    return renderer.renderResult(
        { content: [{ type: "text", text }] },
        {},
        theme,
        { toolCallId, isError }
    ) as Rendered;
}

/**
 * Re-renders an owning row — the first call of a group — the way the host repaints
 * it. `ownerId` defaults to the id used by the single-group tests.
 */
function ownerCard(
    renderer: ReturnType<typeof renderers>,
    expanded = false,
    ownerId = "a",
    command = "echo first"
): string {
    return call(renderer, ownerId, command, expanded).render(80).join("\n");
}

void describe("grouped shell renderers", () => {
    void it("leaves pi's native shell rendering in place when off", () => {
        let tool: CapturedTool | undefined;
        const pi = {
            registerTool: (definition: CapturedTool) => {
                tool = definition;
            },
            on() {},
        };
        registerBashTool(
            pi as never,
            new BackgroundRegistry(),
            createBashToolDefinition(process.cwd()),
            false
        );
        // renderCall is pi's own (inherited); renderShell is what grouping adds,
        // and it is what makes an empty row possible.
        assert.equal(tool?.renderShell, undefined);
    });

    void it("are registered when grouping is on", () => {
        let tool: CapturedTool | undefined;
        const pi = {
            registerTool: (definition: CapturedTool) => {
                tool = definition;
            },
            on() {},
        };
        registerBashTool(
            pi as never,
            new BackgroundRegistry(),
            createBashToolDefinition(process.cwd()),
            true
        );
        assert.equal(tool?.renderShell, "self");
    });

    void it("take over the shell so sibling rows can render nothing", () => {
        assert.equal(renderers().renderShell, "self");
    });

    void it("render the card on the first row and nothing on the rest", () => {
        const renderer = renderers();
        assert.match(call(renderer, "a", "echo first").render(80).join("\n"), /^⏺ 1 command · echo first/);
        assert.deepEqual(
            call(renderer, "b", "echo second").render(80),
            [],
            "sibling rows must be empty"
        );
    });

    void it("marks a failed command from the context, not the result", () => {
        const renderer = renderers();
        call(renderer, "a", "echo first");
        // pi strips isError from the result object it hands the renderer.
        result(renderer, "a", "cat: nope: No such file or directory", true);
        const card = ownerCard(renderer, true);
        assert.match(card, /✗ \$ echo first/);
        assert.match(card, /cat: nope: No such file or directory/);
    });

    void it("marks a manually backgrounded command as still running", () => {
        const renderer = renderers();
        call(renderer, "a", "echo first");
        result(
            renderer,
            "a",
            "Command was manually backgrounded by user with ID: shell-1. Output is being written to: /tmp/pi-bg/shell-1.log",
            false
        );
        assert.match(ownerCard(renderer, true), /▶ \$ echo first/);
    });

    void it("marks an auto-backgrounded command as still running", () => {
        const renderer = renderers();
        call(renderer, "a", "echo first");
        result(
            renderer,
            "a",
            "Command running in background with ID: shell-2. Output is being written to: /tmp/pi-bg/shell-2.log",
            false
        );
        assert.match(ownerCard(renderer, true), /▶ \$ echo first/);
    });

    void it("applies a submission at the next step boundary, not mid-step", () => {
        const handlers = new Map<string, (event?: unknown) => void>();
        const renderer = createGroupedShellRenderers(fakePi(handlers));
        // The command already in flight belongs to the group it started in.
        call(renderer, "a", "echo first");
        handlers.get("input")!({ text: "next prompt" });
        call(renderer, "b", "echo second");
        assert.match(call(renderer, "a", "echo first", true).render(80).join("\n"), /echo second/);

        // The step boundary after the submission opens the next card.
        handlers.get("turn_start")!();
        call(renderer, "c", "echo third");
        assert.match(ownerCard(renderer, false, "c", "echo third"), /^⏺ 1 command · echo third/);
    });

    void it("resets when a queued user message reaches the loop", () => {
        const handlers = new Map<string, (event?: unknown) => void>();
        const renderer = createGroupedShellRenderers(fakePi(handlers));
        call(renderer, "a", "echo first");
        handlers.get("message_start")!({ message: { role: "user" } });
        call(renderer, "b", "echo second");
        assert.match(ownerCard(renderer, false, "b", "echo second"), /^⏺ 1 command · echo second/);
    });

    void it("ignores non-user messages and slash commands", () => {
        const handlers = new Map<string, (event?: unknown) => void>();
        const renderer = createGroupedShellRenderers(fakePi(handlers));
        call(renderer, "a", "echo first");
        handlers.get("message_start")!({ message: { role: "assistant" } });
        handlers.get("message_start")!({ message: { role: "toolResult" } });
        handlers.get("input")!({ text: "/changelog" });
        handlers.get("turn_start")!();
        call(renderer, "b", "echo second");
        assert.match(ownerCard(renderer), /^⏺ 2 commands/);
    });

    void it("resets on a fresh run", () => {
        const handlers = new Map<string, (event?: unknown) => void>();
        const renderer = createGroupedShellRenderers(fakePi(handlers));
        call(renderer, "a", "echo first");
        handlers.get("agent_start")!();
        call(renderer, "b", "echo second");
        assert.match(ownerCard(renderer, false, "b", "echo second"), /^⏺ 1 command · echo second/);
    });

    void it("leaves an in-flight command in its own card after a new prompt", () => {
        const handlers = new Map<string, (event?: unknown) => void>();
        const renderer = createGroupedShellRenderers(fakePi(handlers));
        // Group one starts a slow command and the user moves on before it ends.
        call(renderer, "slow", "sleep 30");
        handlers.get("input")!({ text: "next prompt" });
        handlers.get("turn_start")!();
        call(renderer, "next", "echo next");

        // Its result must land on the first card, not the second.
        result(renderer, "slow", "finished late", false);
        assert.match(call(renderer, "slow", "sleep 30", true).render(80).join("\n"), /finished late/);
        assert.doesNotMatch(ownerCard(renderer, true), /sleep 30/);
    });
});
