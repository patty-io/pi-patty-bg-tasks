/**
 * Unit tests for grouped shell rendering (--group-commands).
 *
 * The card is asserted as text with a pass-through theme, so the layout rules
 * (collapsed header, expanded list, eliding, per-command status) are pinned
 * without a TUI.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    createTurnGroup,
    GROUP_ENV,
    GROUP_FLAG,
    groupingEnabled,
    isOwner,
    noteCall,
    noteResult,
    renderGroupCard,
    resultTail,
    statusFor,
    type CardTheme,
    type TurnGroup,
} from "../grouping.ts";

/** Strips colour calls so assertions read the layout, not the escapes. */
const plain: CardTheme = {
    fg: (_colour: string, text: string) => text,
    bold: (text: string) => text,
};

function groupOf(commands: string[]): TurnGroup {
    const group = createTurnGroup();
    commands.forEach((command, index) => {
        noteCall(group, `tc-${index}`, command, 1_000);
        noteResult(group, `tc-${index}`, false, `out-${index}`, 2_000);
    });
    return group;
}

void describe("groupingEnabled", () => {
    void it("is off by default", () => {
        assert.equal(groupingEnabled([], {}), false);
    });
    void it("reads the flag in either form", () => {
        assert.equal(groupingEnabled(["--group-commands"], {}), true);
        assert.equal(groupingEnabled(["--group-commands=false"], {}), true);
        assert.equal(groupingEnabled(["--other"], {}), false);
    });
    void it("does not match a longer flag that shares the prefix", () => {
        assert.equal(groupingEnabled(["--group-commands-extra"], {}), false);
    });
    void it("reads the env var, ignoring falsey spellings", () => {
        assert.equal(groupingEnabled([], { [GROUP_ENV]: "1" }), true);
        assert.equal(groupingEnabled([], { [GROUP_ENV]: "true" }), true);
        assert.equal(groupingEnabled([], { [GROUP_ENV]: "0" }), false);
        assert.equal(groupingEnabled([], { [GROUP_ENV]: "FALSE" }), false);
        assert.equal(groupingEnabled([], { [GROUP_ENV]: "" }), false);
    });
    void it("uses the documented names", () => {
        assert.equal(GROUP_FLAG, "group-commands");
        assert.equal(GROUP_ENV, "PI_BG_GROUP_COMMANDS");
    });
});

void describe("turn group state", () => {
    void it("only the first call of the turn owns the row", () => {
        const group = groupOf(["echo one", "echo two"]);
        assert.equal(isOwner(group, "tc-0"), true);
        assert.equal(isOwner(group, "tc-1"), false);
    });
    void it("refreshes the command when args arrive after the first render", () => {
        const group = createTurnGroup();
        noteCall(group, "tc-0", "", 1_000);
        assert.equal(group.commands[0]?.command, "");
        noteCall(group, "tc-0", "echo late", 1_000);
        assert.equal(group.commands.length, 1);
        assert.equal(group.commands[0]?.command, "echo late");
    });
    void it("collapses multi-line commands to one line", () => {
        const group = createTurnGroup();
        noteCall(group, "tc-0", "echo one\n  echo two", 1_000);
        assert.equal(group.commands[0]?.command, "echo one echo two");
    });
    void it("records duration and the last output line", () => {
        const group = createTurnGroup();
        noteCall(group, "tc-0", "echo hi", 1_000);
        noteResult(group, "tc-0", false, resultTail([{ type: "text", text: "\nfirst\n\nsecond\n" }]), 4_500);
        assert.equal(group.commands[0]?.status, "done");
        assert.equal(group.commands[0]?.tail, "second");
        assert.equal(group.commands[0]?.endedAt, 4_500);
    });
    void it("has no status for a call that never ran", () => {
        const group = createTurnGroup();
        assert.equal(noteResult(group, "missing", false, "", 1_000), undefined);
    });
});

void describe("resultTail", () => {
    void it("takes the last non-empty text line", () => {
        assert.equal(resultTail([{ type: "text", text: "one\n\ntwo\n\n" }]), "two");
    });
    void it("walks back to the last text block that has content", () => {
        assert.equal(
            resultTail([{ type: "text", text: "kept" }, { type: "image" }, { type: "text", text: "\n" }]),
            "kept"
        );
    });
    void it("is empty for missing or non-text content", () => {
        assert.equal(resultTail(undefined), "");
        assert.equal(resultTail("nope"), "");
        assert.equal(resultTail([{ type: "image" }]), "");
    });
});

void describe("statusFor", () => {
    void it("errors are failed", () => {
        assert.equal(statusFor(true, "boom"), "failed");
    });
    void it("a promoted command is not done", () => {
        assert.equal(
            statusFor(false, "Command running in background with ID: shell-1. Output is being written to: /tmp/x.log"),
            "background"
        );
    });
    void it("everything else is done", () => {
        assert.equal(statusFor(false, "all checks passed"), "done");
    });
});

void describe("renderGroupCard", () => {
    void it("collapsed is one line naming the command count", () => {
        const lines = renderGroupCard(groupOf(["echo one", "echo two"]), false, plain).split("\n");
        assert.equal(lines.length, 1);
        assert.equal(lines[0], "⏺ 2 commands · echo two  (ctrl+o to expand)");
    });
    void it("collapsed omits the expand hint for a single command", () => {
        assert.equal(
            renderGroupCard(groupOf(["echo one"]), false, plain),
            "⏺ 1 command · echo one  (ctrl+o)"
        );
    });
    void it("expanded lists every command with its output and duration", () => {
        const lines = renderGroupCard(groupOf(["echo one", "echo two"]), true, plain).split("\n");
        assert.deepEqual(lines, [
            "⏺ 2 commands · echo two",
            "  ✓ $ echo one (1s)",
            "      out-0",
            "  ✓ $ echo two (1s)",
            "      out-1",
        ]);
    });
    void it("expanded marks a failed command", () => {
        const group = createTurnGroup();
        noteCall(group, "tc-0", "exit 1", 1_000);
        noteResult(group, "tc-0", true, "boom", 2_000);
        const lines = renderGroupCard(group, true, plain).split("\n");
        assert.equal(lines[1], "  ✗ $ exit 1 (1s)");
    });
    void it("expanded shows a running command without a duration", () => {
        const group = createTurnGroup();
        noteCall(group, "tc-0", "sleep 1", 1_000);
        const lines = renderGroupCard(group, true, plain).split("\n");
        assert.equal(lines[1], "  ▶ $ sleep 1");
    });
    void it("elides the oldest commands past the listed maximum", () => {
        const commands = Array.from({ length: 14 }, (_, i) => `echo ${i}`);
        const lines = renderGroupCard(groupOf(commands), true, plain).split("\n");
        assert.equal(lines[1], "  … 2 earlier");
        assert.equal(lines.at(-2), "  ✓ $ echo 13 (1s)");
    });
    void it("keeps the header to one line for a very long command", () => {
        const long = `echo ${"x".repeat(400)}`;
        const card = renderGroupCard(groupOf([long]), false, plain);
        assert.equal(card.split("\n").length, 1);
        assert.ok(card.length < 200, `header too long: ${card.length}`);
    });
});
