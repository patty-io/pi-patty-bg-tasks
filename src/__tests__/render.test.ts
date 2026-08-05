import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { renderBashBgCall } from "../render.ts";

const theme = {
    fg: (color: "muted" | "toolTitle", text: string) => `[${color}:${text}]`,
    bold: (text: string) => `*${text}*`,
};

test("renders a plain background command without its name", () => {
    const component = renderBashBgCall(
        { command: "echo hello", name: "greeting" },
        theme,
        {},
    );
    const output = renderedText(component);

    assert.equal(output, "[toolTitle:*$ echo hello*]");
    assert.doesNotMatch(output, /greeting/);
});

test("renders a background command with a timeout", () => {
    const component = renderBashBgCall(
        { command: "pnpm test", timeout: 30 },
        theme,
        {},
    );

    assert.equal(
        renderedText(component),
        "[toolTitle:*$ pnpm test*][muted: (timeout 30s)]",
    );
});

test("omits the timeout suffix when timeout is absent", () => {
    const component = renderBashBgCall({ command: "pnpm check" }, theme, {});

    assert.equal(renderedText(component), "[toolTitle:*$ pnpm check*]");
});

test("renders missing arguments with an ellipsis", () => {
    const component = renderBashBgCall(undefined, theme, {});

    assert.equal(renderedText(component), "[toolTitle:*$ *][muted:...]");
});

test("renders a whitespace-only command with an ellipsis", () => {
    const component = renderBashBgCall({ command: "  " }, theme, {});

    assert.equal(renderedText(component), "[toolTitle:*$ *][muted:...]");
});

test("reuses and updates the last component", () => {
    const firstComponent = renderBashBgCall({ command: "echo first" }, theme, {});
    const secondComponent = renderBashBgCall(
        { command: "echo second" },
        theme,
        { lastComponent: firstComponent },
    );

    assert.strictEqual(secondComponent, firstComponent);
    assert.equal(renderedText(secondComponent), "[toolTitle:*$ echo second*]");
});

test("replaces a foreign cached component", () => {
    const foreignComponent = {};
    const component = renderBashBgCall(
        { command: "echo fresh" },
        theme,
        { lastComponent: foreignComponent as unknown as Text },
    );

    assert.ok(component instanceof Text);
    assert.notStrictEqual(component, foreignComponent);
    assert.equal(renderedText(component), "[toolTitle:*$ echo fresh*]");
});

test("renders a background command with wide glyphs", () => {
    const component = renderBashBgCall({ command: "echo 你好 🎉" }, theme, {});

    assert.equal(renderedText(component), "[toolTitle:*$ echo 你好 🎉*]");
});

function renderedText(component: Text): string {
    return component.render(200).map((line) => line.trimEnd()).join("\n");
}
