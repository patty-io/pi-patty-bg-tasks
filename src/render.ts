/** Call-row renderer for bash_bg, showing commands like native bash. */
import { Text, type Component } from "@earendil-works/pi-tui";

type CallArgs = Record<string, unknown>;

type RenderTheme = {
    fg(color: "muted" | "toolTitle", text: string): string;
    bold(text: string): string;
};

type RenderContext = {
    lastComponent?: Component;
};

export function renderBashBgCall(args: unknown, theme: RenderTheme, context: RenderContext): Text {
    const values = asCallArgs(args);
    const command = nonEmptyString(values.command);
    const commandDisplay = command === undefined
        ? styledTitle("$ ", theme) + theme.fg("muted", "...")
        : styledTitle(`$ ${command}`, theme);
    const timeoutSuffix = renderTimeout(values.timeout, theme);

    return renderCall(commandDisplay + timeoutSuffix, context);
}

function renderCall(content: string, context: RenderContext): Text {
    const previousComponent = context.lastComponent;
    const text = previousComponent instanceof Text ? previousComponent : new Text("", 0, 0);
    text.setText(content);
    return text;
}

function renderTimeout(value: unknown, theme: RenderTheme): string {
    return typeof value === "number" && Number.isFinite(value)
        ? theme.fg("muted", ` (timeout ${value}s)`)
        : "";
}

function styledTitle(title: string, theme: RenderTheme): string {
    return theme.fg("toolTitle", theme.bold(title));
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asCallArgs(args: unknown): CallArgs {
    return typeof args === "object" && args !== null ? args as CallArgs : {};
}
