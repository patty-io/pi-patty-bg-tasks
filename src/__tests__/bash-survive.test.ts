import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { registerBashTool } from "../tools/bash.ts";
import { processExists, killProcessTree } from "../spawn.ts";
import type { Job } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(50);
    }
    return predicate();
}

interface ToolDef {
    execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<unknown>;
}

function harness() {
    let tool: ToolDef | undefined;
    const pi = {
        registerTool: (def: ToolDef) => { tool = def; },
        sendMessage: () => {},
    };
    const reg = new BackgroundRegistry();
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

void describe("bash foreground — Claude Code parity on turn abort", () => {
    const spawnedPids: number[] = [];

    void it("a genuine cancel (Esc) KILLS the foreground command", async () => {
        const { tool, reg, ctx } = harness();
        const ac = new AbortController();
        const execution = tool.execute(
            "t1",
            { command: 'node -e "setInterval(() => {}, 1000)"' },
            ac.signal,
            undefined,
            ctx
        );
        // Windows taskkill reports a different exit code than POSIX signals;
        // cancellation is asserted through process liveness below.
        void execution.catch(() => {});
        await sleep(400);

        const job = [...reg.jobs.values()][0] as Job;
        const pid = job.pid;
        spawnedPids.push(pid);
        assert.ok(processExists(pid), "running before the abort");

        // No pause was requested → this is a deliberate cancel → CC kills it.
        ac.abort();

        assert.ok(
            await waitUntil(() => !processExists(pid)),
            "process is killed on a genuine cancel (CC parity)"
        );
    });

    void it("a backgrounding pause (steering / Ctrl+B) SURVIVES the abort", async () => {
        const { tool, reg, ctx } = harness();
        const ac = new AbortController();
        void tool.execute(
            "t2",
            { command: 'node -e "setInterval(() => {}, 1000)"' },
            ac.signal,
            undefined,
            ctx
        );
        await sleep(400);

        const job = [...reg.jobs.values()][0] as Job;
        const pid = job.pid;
        spawnedPids.push(pid);

        // Cooperative path: a pause is requested (as steering / Ctrl+B does)
        // BEFORE the abort — CC's 'interrupt'/background path never kills.
        reg.foreground.get(job.toolCallId)?.requestPause("manual");
        ac.abort();
        await sleep(200);

        assert.ok(processExists(pid), "backgrounded command survives the abort");
    });

    after(async () => {
        for (const pid of spawnedPids) {
            try { killProcessTree(pid, "SIGKILL"); } catch { /* already gone */ }
        }
        await Promise.all(
            spawnedPids.map((pid) => waitUntil(() => !processExists(pid)))
        );
    });
});
