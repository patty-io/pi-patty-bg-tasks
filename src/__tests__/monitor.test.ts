import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import { registerMonitorTool } from "../tools/monitor.ts";
import { reviveAndValidate } from "../lifecycle.ts";
import { spawnWithFileOutput } from "../spawn.ts";
import { openWsSource, isWsSupported } from "../monitor-ws.ts";
import { flushTurnBoundaryNotices } from "../notify.ts";
import { EVENT, type Job } from "../types.ts";

const dir = join(tmpdir(), `pi-bg-monitor-${process.pid}`);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CapturedTool {
    execute: (
        toolCallId: string,
        params: unknown,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<{ content: { type: "text"; text: string }[] }>;
}

function makeHarness() {
    const messages: { customType: string; details?: Record<string, unknown> }[] = [];
    let tool: CapturedTool | undefined;
    const pi = {
        registerTool(def: CapturedTool) {
            tool = def;
        },
        sendMessage(msg: { customType: string; details?: Record<string, unknown> }) {
            messages.push(msg);
        },
    };
    const reg = new BackgroundRegistry();
    registerMonitorTool(pi as never, reg);
    const ctx = {
        cwd: process.cwd(),
        ui: {
            notify() {},
            setWidget() {},
            setStatus() {},
            theme: { fg: (_c: string, t: string) => t },
        },
    };
    return { tool: tool!, reg, ctx, messages, pi };
}

void describe("monitor tool — validation", () => {
    void it("rejects when neither command nor ws is given", async () => {
        const { tool, ctx } = makeHarness();
        await assert.rejects(
            () => tool.execute("t1", { description: "x" }, undefined, undefined, ctx),
            /needs a `command` or a `ws`/
        );
    });

    void it("rejects when both command and ws are given", async () => {
        const { tool, ctx } = makeHarness();
        await assert.rejects(
            () =>
                tool.execute(
                    "t2",
                    { command: "echo hi", ws: { url: "ws://x" }, description: "x" },
                    undefined,
                    undefined,
                    ctx
                ),
            /not both/
        );
    });

    void it("rejects a blank description", async () => {
        const { tool, ctx } = makeHarness();
        await assert.rejects(
            () => tool.execute("t3", { command: "echo hi", description: "   " }, undefined, undefined, ctx),
            /description` is required/
        );
    });
});

void describe("monitor tool — command lifecycle", () => {
    void it("streams lines live, and coalesces the terminal into one notice", async () => {
        const { tool, ctx, messages, reg, pi } = makeHarness();
        const res = await tool.execute(
            "t4",
            { command: "printf 'line-A\\nline-B\\n'", description: "test stream" },
            undefined,
            undefined,
            ctx
        );
        assert.match(res.content[0].text, /Monitor job-.* started/);

        await sleep(300); // let the source exit + terminal enqueue
        flushTurnBoundaryNotices(reg, pi as never, ctx as never); // force the coalesced flush

        // Stream lines are delivered live as monitor events.
        const monitorEvents = messages.filter((m) => m.customType === EVENT.monitorEvent);
        const streamText = monitorEvents
            .map((m) => (m as unknown as { content: string }).content)
            .join("\n");
        assert.ok(monitorEvents.length >= 1, "expected at least one live stream event");
        assert.match(streamText, /line-A/);
        assert.match(streamText, /line-B/);

        // The terminal notice is now coalesced into exactly one jobFinished.
        const terminals = messages.filter((m) => m.customType === EVENT.jobFinished);
        assert.equal(terminals.length, 1, "exactly one coalesced terminal notice");
        assert.match(
            (terminals[0] as unknown as { content: string }).content,
            /test stream — stream ended/
        );
    });
});

void describe("monitor — split spawn output", () => {
    void it("writes stdout and stderr to separate files when errPath is set", async () => {
        const logPath = join(dir, "split.log");
        const errPath = join(dir, "split.err");
        const r = spawnWithFileOutput({
            command: "echo OUT; echo ERR >&2",
            cwd: process.cwd(),
            logPath,
            errPath,
            keepRef: true,
        });
        await r.exit;
        assert.match(readFileSync(logPath, "utf-8"), /OUT/);
        assert.doesNotMatch(readFileSync(logPath, "utf-8"), /ERR/);
        assert.match(readFileSync(errPath, "utf-8"), /ERR/);
    });
});

void describe("monitor — revival", () => {
    void it("marks a persisted monitor terminal instead of reviving it", () => {
        const job = {
            id: `job-${process.pid}-9`,
            command: "ws wss://x",
            pid: 0,
            startTime: Date.now(),
            status: "running",
            logPath: join(dir, "x.log"),
            toolCallId: "t",
            isBackgrounded: true,
            kind: "monitor",
        } as Job;
        const verdict = reviveAndValidate(new BackgroundRegistry(), job);
        assert.equal(verdict, "completed");
        assert.equal(job.status, "failed");
    });

    void it("keeps a still-alive command monitor running (not orphaned)", () => {
        // pid = this process (alive), id encodes this process → same-session reload.
        const job = {
            id: `job-${process.pid}-10`,
            command: "tail -f app.log",
            pid: process.pid,
            startTime: Date.now(),
            status: "running",
            logPath: join(dir, "cmd.log"),
            toolCallId: "t",
            isBackgrounded: true,
            kind: "monitor",
        } as Job;
        const verdict = reviveAndValidate(new BackgroundRegistry(), job);
        assert.equal(verdict, "alive");
        assert.equal(job.status, "running");
    });
});

// --- WebSocket source (stubbed global WebSocket) -------------------------

class FakeWS {
    static instances: FakeWS[] = [];
    listeners: Record<string, ((ev: unknown) => void)[]> = {};
    url: string;
    protocols?: string[];
    constructor(url: string, protocols?: string[]) {
        this.url = url;
        this.protocols = protocols;
        FakeWS.instances.push(this);
    }
    addEventListener(type: string, cb: (ev: unknown) => void) {
        (this.listeners[type] ??= []).push(cb);
    }
    close() {
        this.dispatch("close", { code: 1000, reason: "" });
    }
    dispatch(type: string, ev: unknown) {
        for (const cb of this.listeners[type] ?? []) cb(ev);
    }
}

void describe("monitor — ws source mapping", () => {
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    before(() => {
        (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS as unknown;
    });
    after(() => {
        (globalThis as { WebSocket?: unknown }).WebSocket = original;
    });

    void it("appends text frames and a binary placeholder to the log", async () => {
        assert.ok(isWsSupported());
        const logPath = join(dir, "ws.log");
        const src = openWsSource({ url: "wss://example/feed" }, logPath);
        const ws = FakeWS.instances[FakeWS.instances.length - 1];

        ws.dispatch("message", { data: "hello" });
        ws.dispatch("message", { data: new ArrayBuffer(7) });
        ws.dispatch("message", { data: "world" });
        ws.dispatch("close", { code: 1000, reason: "" });

        await src.exit;
        const body = readFileSync(logPath, "utf-8");
        assert.match(body, /hello/);
        assert.match(body, /\[binary frame, 7 bytes\]/);
        assert.match(body, /world/);
        assert.match(body, /socket closed: code 1000/);
    });
});

after(() => {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});
