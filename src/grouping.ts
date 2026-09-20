/**
 * Optional grouped rendering for a turn's shell calls (--group-commands).
 *
 * Claude Code / Codex style: the turn's first shell row becomes one collapsible
 * card listing every command the turn ran, and the remaining rows render
 * nothing. Off by default.
 *
 * Why this lives in the bash tool and not in a separate add-on: pi binds a
 * tool's execution and its renderers to the same name, and a second extension
 * registering `bash` is a hard startup error. Whoever owns the shell tool is
 * therefore also its only renderer. Hiding rows is a transcript behaviour
 * change, so it stays opt-in.
 *
 * Why the env var too: pi resolves extension flag values *after* the extension
 * factories run, but `renderShell` is fixed when the tool is registered. The
 * switch has to be resolved at load time, so we read it here (the flag is still
 * registered for help text and validation).
 */
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration, oneLine } from "./format.ts";

export const GROUP_FLAG = "group-commands";
export const GROUP_ENV = "PI_BG_GROUP_COMMANDS";

/** Commands listed on an expanded card before the oldest start being elided. */
const MAX_LISTED = 12;
/** Command preview length on the collapsed header. */
const HEADER_COMMAND_CHARS = 80;

export type CommandStatus = "running" | "background" | "done" | "failed";

export interface GroupedCommand {
    id: string;
    command: string;
    status: CommandStatus;
    /** Last non-empty output line — the expanded card's one-line result. */
    tail: string;
    startedAt: number;
    endedAt?: number;
}

/** The shell calls made since the current turn started. */
export interface TurnGroup {
    commands: GroupedCommand[];
}

/** Minimal theme surface the card needs — pi's Theme is structurally wider. */
export interface CardTheme {
    fg(colour: string, text: string): string;
    bold(text: string): string;
}

const STATUS = {
    running: { glyph: "▶", colour: "warning" },
    background: { glyph: "▶", colour: "accent" },
    done: { glyph: "✓", colour: "success" },
    failed: { glyph: "✗", colour: "error" },
} as const satisfies Record<CommandStatus, { glyph: string; colour: string }>;

const FALSEY = new Set(["0", "false", "no", "off"]);

/**
 * Whether grouped rendering is switched on.
 *
 * Mirrors pi's own flag parsing: boolean extension flags are set by presence,
 * and any `=value` is ignored (`--group-commands=false` still means on), so
 * presence is what counts here too.
 */
export function groupingEnabled(
    argv: readonly string[] = process.argv,
    env: NodeJS.ProcessEnv = process.env
): boolean {
    const fromEnv = (env[GROUP_ENV] ?? "").trim().toLowerCase();
    if (fromEnv !== "" && !FALSEY.has(fromEnv)) return true;
    const flag = `--${GROUP_FLAG}`;
    return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function createTurnGroup(): TurnGroup {
    return { commands: [] };
}

/** The row that renders the card: the turn's first shell call. */
export function isOwner(group: TurnGroup, toolCallId: string): boolean {
    return group.commands[0]?.id === toolCallId;
}

/**
 * Register the call, or refresh it — args stream in, so the command text can
 * arrive after the first render.
 */
export function noteCall(
    group: TurnGroup,
    toolCallId: string,
    command: string,
    now: number
): GroupedCommand {
    let entry = group.commands.find((c) => c.id === toolCallId);
    if (!entry) {
        entry = {
            id: toolCallId,
            command: "",
            status: "running",
            tail: "",
            startedAt: now,
        };
        group.commands.push(entry);
    }
    if (command) entry.command = oneLine(command);
    return entry;
}

/**
 * Status for a finished call. A command that moved to the background is not
 * "done": the job is still running and the jobs widget owns it from here.
 * Both spellings come from the shell tool — auto/timeout promotion says
 * "running in background with ID", Ctrl+Shift+B says "manually backgrounded by
 * user with ID".
 */
export function statusFor(isError: boolean, tail: string): CommandStatus {
    if (isError) return "failed";
    return /(?:running in background|backgrounded by user) with ID/.test(tail)
        ? "background"
        : "done";
}

/**
 * Last non-empty line of a tool result's text blocks — the card's result preview.
 * The content shape is pi's, so this stays defensive rather than typed.
 */
export function resultTail(content: unknown): string {
    if (!Array.isArray(content)) return "";
    for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i] as { type?: string; text?: unknown } | undefined;
        if (block?.type !== "text" || typeof block.text !== "string") continue;
        const lines = block.text.split("\n").filter((line) => line.trim() !== "");
        if (lines.length > 0) return lines[lines.length - 1].trim();
    }
    return "";
}

export function noteResult(
    group: TurnGroup,
    toolCallId: string,
    isError: boolean,
    tail: string,
    now: number
): GroupedCommand | undefined {
    const entry = group.commands.find((c) => c.id === toolCallId);
    if (!entry) return undefined;
    entry.tail = oneLine(tail);
    entry.status = statusFor(isError, entry.tail);
    entry.endedAt = now;
    return entry;
}

/**
 * Collapse the shell rows of one user turn into a single card.
 *
 * Where a group ends is surprisingly fiddly, so all four signals are used:
 *   - `input` fires the moment the user submits, including prompts queued while
 *     the agent is still streaming (steer / follow-up). Resetting *there* would
 *     steal the command that is already in flight, so it only arms a pending
 *     reset.
 *   - `turn_start` applies a pending reset. A pi turn is one agent-loop step, and
 *     the next one begins only after the current step's tools have finished, so
 *     this is the first safe boundary after a submission. (`turn_start` alone
 *     cannot be the boundary: sequential commands each get their own step, which
 *     would open a card per command.)
 *   - `message_start` for a user message resets immediately — that is when a
 *     queued prompt is actually handed to the loop.
 *   - `agent_start` covers prompts that never came through the TUI
 *     (`sendUserMessage` from another extension) and runs after the agent idled.
 *
 * Only the first call of a group is rendered; the rest return an empty Text, which
 * disappears because the tool registers `renderShell: "self"` (the default shell
 * would leave its leading spacer behind as a blank row).
 *
 * Sibling rows repaint the owner through its deferred `invalidate`: calling it
 * synchronously re-enters updateDisplay on the row that is mid-render, which recurses
 * until the host's renderer fallback kicks in.
 */
export function createGroupedShellRenderers(pi: ExtensionAPI) {
    let current: TurnGroup = createTurnGroup();
    let pendingReset = false;
    // A call keeps the group it started in, so a command that finishes after the
    // user has moved on still updates its own card instead of the new one.
    // ponytail: one small entry per shell call for the life of the session; prune
    // by insertion order if a marathon session ever makes this measurable.
    const groups = new Map<string, TurnGroup>();
    const repaintOf = new WeakMap<TurnGroup, () => void>();
    const nudged = new WeakSet<TurnGroup>();

    const reset = () => {
        current = createTurnGroup();
        pendingReset = false;
    };
    pi.on("input", (event) => {
        // Slash commands are not prompts; they should not split the card.
        if (event?.text?.startsWith("/")) return;
        pendingReset = true;
    });
    pi.on("turn_start", () => {
        if (pendingReset) reset();
    });
    pi.on("message_start", (event) => {
        if (event?.message?.role === "user") reset();
    });
    pi.on("agent_start", reset);

    const groupFor = (toolCallId: string): TurnGroup => {
        const existing = groups.get(toolCallId);
        if (existing) return existing;
        groups.set(toolCallId, current);
        return current;
    };

    const nudge = (group: TurnGroup) => {
        if (nudged.has(group)) return;
        nudged.add(group);
        queueMicrotask(() => {
            nudged.delete(group);
            repaintOf.get(group)?.();
        });
    };

    return {
        renderShell: "self" as const,
        renderCall(
            args: { command?: string },
            theme: CardTheme,
            context: { toolCallId: string; expanded: boolean; invalidate(): void }
        ) {
            const group = groupFor(context.toolCallId);
            noteCall(group, context.toolCallId, args?.command ?? "", Date.now());
            if (!isOwner(group, context.toolCallId)) {
                nudge(group);
                return new Text("");
            }
            repaintOf.set(group, context.invalidate);
            return new Text(renderGroupCard(group, context.expanded, theme), 0, 0);
        },
        renderResult(
            result: { content?: unknown; isError?: boolean },
            _options: unknown,
            _theme: unknown,
            context: { toolCallId: string; isError?: boolean }
        ) {
            const group = groupFor(context.toolCallId);
            noteResult(
                group,
                context.toolCallId,
                // pi hands the renderer {content, details} and keeps the error flag on
                // the context — result.isError is not populated.
                (context.isError ?? result?.isError) === true,
                resultTail(result?.content),
                Date.now()
            );
            if (!isOwner(group, context.toolCallId)) nudge(group);
            // The owner's call slot already renders the card; keep this slot empty so
            // the row does not render twice.
            return new Text("");
        },
    };
}

/**
 * Collapsed: a single summary line. Expanded: the summary plus every command
 * with its duration and last output line. Returned as plain text — the tool
 * renderer wraps it in a pi-tui Text so wrapping and ANSI stay core's job.
 */
export function renderGroupCard(
    group: TurnGroup,
    expanded: boolean,
    theme: CardTheme
): string {
    const count = group.commands.length;
    const current = group.commands[count - 1];
    const command = (current?.command ?? "").slice(0, HEADER_COMMAND_CHARS);
    const header =
        theme.fg("accent", "⏺ ") +
        theme.bold(`${count} command${count === 1 ? "" : "s"}`) +
        theme.fg("muted", ` · ${command}`);

    if (!expanded) {
        return header + theme.fg("dim", `  (${count > 1 ? "ctrl+o to expand" : "ctrl+o"})`);
    }

    const shown = group.commands.slice(-MAX_LISTED);
    const elided = count - shown.length;
    const lines = [header];
    if (elided > 0) lines.push(theme.fg("dim", `  … ${elided} earlier`));
    for (const entry of shown) {
        const { glyph, colour } = STATUS[entry.status];
        const duration =
            entry.endedAt === undefined
                ? ""
                : ` (${formatDuration(entry.endedAt - entry.startedAt)})`;
        lines.push(
            theme.fg(colour, `  ${glyph} `) +
                theme.fg("toolTitle", `$ ${entry.command}`) +
                theme.fg("dim", duration)
        );
        if (entry.tail) lines.push(theme.fg("toolOutput", `      ${entry.tail}`));
    }
    return lines.join("\n");
}
