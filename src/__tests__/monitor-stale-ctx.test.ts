import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import { add, createRunningJob } from "../registry.ts";
import { startMonitorSession } from "../monitor-session.ts";
import type { MonitorSource } from "../monitor-source.ts";
import type { SpawnExit } from "../spawn.ts";
import type { UiContext } from "../types.ts";

const dir = join(tmpdir(), `pi-bg-stale-${process.pid}`);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

void describe("monitor-session — stale extension ctx", () => {
    void it("a stale ctx in the stream emit stops the monitor instead of crashing pi", async () => {
        const logPath = join(dir, "stale.log");
        writeFileSync(logPath, "");

        // pi.sendMessage throws like pi's assertActive does after
        // ctx.newSession()/fork()/switchSession()/reload().
        let sendAttempts = 0;
        const pi = {
            sendMessage: () => {
                sendAttempts++;
                throw new Error(
                    "This extension ctx is stale after session replacement or reload."
                );
            },
        };
        const ctx = {
            ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c: string, t: string) => t } },
        } as unknown as UiContext;
        const reg = new BackgroundRegistry();

        const exit = new Promise<SpawnExit>(() => {});
        let stopped = false;
        const source: MonitorSource = {
            logPath,
            pid: 0,
            label: "fake",
            exit,
            stop: () => {
                stopped = true;
            },
        };

        const job = createRunningJob({
            id: `job-${process.pid}-stale`,
            name: "watch",
            command: source.label,
            pid: source.pid,
            logPath,
            toolCallId: "t",
            kind: "monitor",
        });
        add(reg, job);

        startMonitorSession({
            pi: pi as never,
            reg,
            ctx,
            job,
            source,
            description: "watch",
            persistent: true,
            timeoutMs: 60_000,
        });

        appendFileSync(logPath, "line-A\n");
        await sleep(300); // > MONITOR_POLL_MS so a real follower tick fires

        assert.ok(sendAttempts >= 1, "the emit was attempted against the stale ctx");
        const attemptsAfterFirst = sendAttempts;
        assert.ok(stopped, "the source was torn down");
        assert.equal(job.status, "killed");
        assert.equal(job.notified, true, "the exit-path notification is latched off");

        // A dead ctx gets no further traffic: new lines must not retry.
        appendFileSync(logPath, "line-B\n");
        await sleep(300);
        assert.equal(sendAttempts, attemptsAfterFirst);
    });
});

process.on("exit", () => {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});
