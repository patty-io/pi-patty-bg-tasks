/**
 * Non-interactive (`pi -p`) foreground bash behavior.
 *
 * These pin the two guarantees the event-loop-liveness fix provides when there
 * is no TUI keeping Node's loop alive (the mode every subagent worker runs in):
 *
 *   1. A short/medium foreground command RESOLVES with its output. The child is
 *      spawned ref'd (keepRef) so its `close` event is delivered even though no
 *      TUI holds the loop open; without the fix the tool's completion race never
 *      settles and the turn ends with no tool result ("Subagent produced no
 *      output").
 *
 *   2. A long foreground command AUTO-BACKGROUNDS in non-interactive mode
 *      instead of bailing. It is promoted to a tracked background job (so the
 *      agent can pick it up via jobs/wait/monitor) and re-detached from the loop
 *      so it can outlive the turn.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { registerBashTool } from "../tools/bash.ts";
import { processExists, killProcessTree } from "../spawn.ts";
import type { Job } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ToolDef {
    execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<{ content: Array<{ text?: string }> }>;
}

function harness(nonInteractive: boolean) {
    let tool: ToolDef | undefined;
    const pi = {
        registerTool: (def: ToolDef) => { tool = def; },
        sendMessage: () => {},
    };
    const reg = new BackgroundRegistry();
    reg.nonInteractive = nonInteractive;
    registerBashTool(pi as never, reg, {} as never);
    const ctx = {
        cwd: process.cwd(),
        ui: {
            notify: () => {},
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_c: string, t: string) => t },
        },
    };
    return { tool: tool!, reg, ctx };
}

void describe("bash foreground — non-interactive (-p) mode", () => {
    const spawnedPids: number[] = [];

    void it("resolves with output for a short command (loop stays alive without a TUI)", async () => {
        const { tool, ctx } = harness(true);
        // A fast command completes inside the quick-completion window. The race
        // can only settle if the ref'd child delivers its `close` event.
        const res = await tool.execute("s1", { command: "echo hello-headless" }, undefined, undefined, ctx);
        const text = res.content.map((c) => c.text ?? "").join("");
        assert.match(text, /hello-headless/, "short command returns its stdout in -p mode");
    });

    void it("resolves with output for a command past the quick-completion window", async () => {
        const { tool, ctx } = harness(true);
        // ~2.5s exceeds the 2s quick window, entering the second (completion vs
        // backgrounding) race. With a long timeout it must resolve via completion.
        const res = await tool.execute(
            "s2",
            { command: "sleep 2.5 && echo late-headless", timeout: 60 },
            undefined,
            undefined,
            ctx
        );
        const text = res.content.map((c) => c.text ?? "").join("");
        assert.match(text, /late-headless/, "medium command returns stdout, not an empty result");
    });

    void it("auto-backgrounds a long command in -p mode instead of bailing", async () => {
        const { tool, reg, ctx } = harness(true);
        // timeout=1s; the command runs longer, so the timeout timer must promote
        // it to a background job (the old code did `if (nonInteractive) return`).
        // Use a non-sleep long runner so patty's sleep-guard doesn't reject it.
        const res = await tool.execute(
            "s3",
            { command: "tail -f /dev/null", timeout: 1 },
            undefined,
            undefined,
            ctx
        );
        const text = res.content.map((c) => c.text ?? "").join("");
        assert.match(text, /backgrounded/i, "long command is auto-backgrounded, not bailed/killed");

        const job = [...reg.jobs.values()].find((j) => (j as Job).isBackgrounded) as Job | undefined;
        assert.ok(job, "a tracked background job exists after promotion");
        spawnedPids.push(job!.pid);
        assert.ok(processExists(job!.pid), "the backgrounded process is still running (survives the turn)");
        assert.equal(reg.totalStarted, 1, "promotion counted the job as started");
    });

    after(() => {
        for (const pid of spawnedPids) {
            try { killProcessTree(pid, "SIGKILL"); } catch { /* already gone */ }
        }
    });
});
