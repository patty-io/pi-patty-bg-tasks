/**
 * Every "started/moved to background" message must carry the wait-reminder so
 * the model knows the job isn't done and how to collect its result. Covers all
 * four backgrounding paths: bash explicit run_in_background, bash auto-background
 * on timeout, and bash_bg. Also pins the mode-specific caveat wording.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { backgroundReminder, textBlock } from "../format.ts";
import { registerBashTool } from "../tools/bash.ts";
import { registerBashBgTool } from "../tools/bash-bg.ts";
import { killProcessTree } from "../spawn.ts";
import type { Job } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ToolDef {
    execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown)
        => Promise<{ content: Array<{ text?: string }> }>;
}

function harness(nonInteractive: boolean) {
    const tools: Record<string, ToolDef> = {};
    const pi = { registerTool: (d: ToolDef & { name: string }) => { tools[d.name] = d; }, sendMessage: () => {} };
    const reg = new BackgroundRegistry();
    reg.nonInteractive = nonInteractive;
    registerBashTool(pi as never, reg, {} as never);
    registerBashBgTool(pi as never, reg);
    const ctx = { cwd: process.cwd(), ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } } };
    return { tools, reg, ctx };
}

const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

void describe("background reminder text", () => {
    void it("always states the job is not finished and lists jobs/wait/monitor", () => {
        for (const ni of [true, false]) {
            const t = backgroundReminder(ni);
            assert.match(t, /NOT finished yet/, "must warn the job isn't done");
            assert.match(t, /jobs action='attach'/, "must mention attach");
            assert.match(t, /wait\(\)/, "must mention wait()");
            assert.match(t, /monitor tool/, "must mention monitor");
        }
    });

    void it("non-interactive caveat warns the result is lost if not waited on", () => {
        assert.match(backgroundReminder(true), /non-interactive run|never see the output/);
    });

    void it("interactive caveat points to a later turn", () => {
        assert.match(backgroundReminder(false), /later turn/);
    });
});

void describe("backgrounding tool results carry the reminder", () => {
    const pids: number[] = [];

    void it("bash run_in_background=true includes it (non-interactive wording)", async () => {
        const { tools, reg, ctx } = harness(true);
        const res = await tools.bash.execute("b1", { command: "tail -f /dev/null", run_in_background: true }, undefined, undefined, ctx);
        for (const j of reg.jobs.values()) pids.push((j as Job).pid);
        assert.match(textOf(res), /runs detached/);
        assert.match(textOf(res), /never see the output/);
    });

    void it("bash auto-background on timeout includes it", async () => {
        const { tools, reg, ctx } = harness(true);
        // timeout=1s, command runs longer → promoted to background.
        const res = await tools.bash.execute("b2", { command: "tail -f /dev/null", timeout: 1 }, undefined, undefined, ctx);
        for (const j of reg.jobs.values()) if ((j as Job).isBackgrounded) pids.push((j as Job).pid);
        assert.match(textOf(res), /backgrounded as/);
        assert.match(textOf(res), /runs detached/);
    });

    void it("bash_bg includes it", async () => {
        const { tools, reg, ctx } = harness(false);
        const res = await tools.bash_bg.execute("b3", { command: "tail -f /dev/null" }, undefined, undefined, ctx);
        for (const j of reg.jobs.values()) pids.push((j as Job).pid);
        assert.match(textOf(res), /running in background/);
        assert.match(textOf(res), /runs detached/);
        assert.match(textOf(res), /later turn/, "interactive harness → interactive caveat");
    });

    after(() => { for (const p of pids) { try { killProcessTree(p, "SIGKILL"); } catch { /* gone */ } } });
});
