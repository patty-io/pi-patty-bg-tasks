/**
 * Unit tests for spawn.ts re-exports and lifecycle.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { killProcessTree, processExists } from "../proc.ts";
import {
    abortJob,
    backgroundActiveForeground,
    completeJob,
    createJobAbort,
    ensureCompletionPromise,
    isSignalExit,
    markKilledSilently,
    markTerminal,
    requestJobDecision,
    statusFromExit,
} from "../lifecycle.ts";
import { BackgroundRegistry } from "../state.ts";
import { BG_TASK_FINISHED_EVENT, EVENT, type Job, type UiContext, type BgTaskFinishedEvent } from "../types.ts";

void describe("processExists", () => {
    void it("the current process is alive", () => {
        assert.equal(processExists(process.pid), true);
    });
    void it("PID 0 is treated as dead", () => {
        assert.equal(processExists(0), false);
    });
    void it("a negative PID is treated as dead", () => {
        assert.equal(processExists(-1), false);
    });
    void it("undefined is treated as dead", () => {
        assert.equal(processExists(undefined), false);
    });
});

void describe("killProcessTree", () => {
    void it("PID 0 / negative / undefined are no-ops", () => {
        // Must not throw.
        killProcessTree(0);
        killProcessTree(-1);
        killProcessTree(undefined);
        killProcessTree(12345678, "SIGTERM"); // dead PID — must not throw.
    });
});

void describe("statusFromExit", () => {
    void it("0 → completed", () => {
        assert.equal(statusFromExit(0), "completed");
    });
    void it("1 → failed", () => {
        assert.equal(statusFromExit(1), "failed");
    });
    void it("null → completed (treated as signal exit)", () => {
        assert.equal(statusFromExit(null), "completed");
    });
    void it("undefined → failed", () => {
        assert.equal(statusFromExit(undefined), "failed");
    });
});

void describe("isSignalExit", () => {
    void it("137 = SIGKILL", () => {
        assert.equal(isSignalExit(137), true);
    });
    void it("143 = SIGTERM", () => {
        assert.equal(isSignalExit(143), true);
    });
    void it("0 is not a signal exit", () => {
        assert.equal(isSignalExit(0), false);
    });
    void it("null is not a signal exit (treated as spawn error)", () => {
        assert.equal(isSignalExit(null), false);
    });
    void it("undefined is not a signal exit", () => {
        assert.equal(isSignalExit(undefined), false);
    });
});

void describe("markTerminal idempotency", () => {
    void it("a second call after completion is ignored", () => {
        const job = makeJob();
        markTerminal(job, "completed", 0);
        markTerminal(job, "failed", 1);
        assert.equal(job.status, "completed");
        assert.equal(job.exitCode, 0);
    });
    void it("killed → killed", () => {
        const job = makeJob();
        markTerminal(job, "killed");
        assert.equal(job.status, "killed");
    });
});

function makeJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-mt-1",
        command: "x",
        pid: 1,
        startTime: 0,
        status: "running",
        logPath: "/tmp/x",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

void describe("ensureCompletionPromise", () => {
    void it("creates donePromise resolvable via resolveDone", async () => {
        const job = makeJob();
        ensureCompletionPromise(job);
        assert.ok(job.donePromise);
        assert.ok(job.resolveDone);
        let resolved = false;
        void job.donePromise.then(() => {
            resolved = true;
        });
        job.resolveDone!();
        await job.donePromise;
        assert.equal(resolved, true);
    });
});

void describe("markKilledSilently", () => {
    void it("status=killed, outputConsumed=true", () => {
        const job = makeJob();
        markKilledSilently(job);
        assert.equal(job.status, "killed");
        assert.equal(job.outputConsumed, true);
    });
});

void describe("createJobAbort / abortJob", () => {
    void it("registers a controller and is idempotent", () => {
        const reg = new BackgroundRegistry();
        const a = createJobAbort(reg, "job-1");
        const b = createJobAbort(reg, "job-1");
        assert.equal(a, b);
        assert.equal(reg.jobAborts.get("job-1"), a);
        assert.equal(a.signal.aborted, false);
    });
    void it("abortJob aborts the signal and removes the controller", () => {
        const reg = new BackgroundRegistry();
        const ac = createJobAbort(reg, "job-2");
        let aborted = false;
        ac.signal.addEventListener("abort", () => {
            aborted = true;
        });
        abortJob(reg, "job-2");
        assert.equal(aborted, true);
        assert.equal(ac.signal.aborted, true);
        assert.equal(reg.jobAborts.has("job-2"), false);
    });
    void it("abortJob on an unknown job is a no-op", () => {
        const reg = new BackgroundRegistry();
        abortJob(reg, "nope"); // must not throw
        assert.equal(reg.jobAborts.has("nope"), false);
    });
});

void describe("BackgroundRegistry defaults", () => {
    void it("initializes default fields", () => {
        const reg = new BackgroundRegistry();
        assert.ok(reg.jobs instanceof Map);
        assert.ok(reg.foreground instanceof Map);
        assert.ok(reg.jobAborts instanceof Map);
        assert.equal(reg.counter, 0);
        assert.equal(reg.activeToolCallId, null);
        assert.equal(reg.totalStarted, 0);
    });
});

void describe("backgroundActiveForeground", () => {
    void it("manual background sends bg-manual without creating a timeout decision", () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const notifications: string[] = [];
        let pauseReason: string | undefined;
        reg.activeToolCallId = "tc-manual";
        reg.foreground.set("tc-manual", {
            requestPause: (reason) => {
                pauseReason = reason;
            },
        });

        const ok = backgroundActiveForeground(
            reg,
            { sendMessage: (msg: { customType?: string }) => sent.push(msg) } as never,
            makeCtx(notifications)
        );

        assert.equal(ok, true);
        assert.equal(pauseReason, "manual");
        assert.equal(reg.pendingDecisionJobId, undefined);
        assert.equal(sent[0]?.customType, EVENT.background);
        assert.equal(notifications[0], "▶ Backgrounded — continuing.");
    });
});

void describe("requestJobDecision", () => {
    void it("timeout background records pending decision and shows only a toast (no forced turn — CC parity)", () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const toasts: string[] = [];
        const job = makeJob({ id: "job-timeout", command: "pnpm test" });

        requestJobDecision({
            reg,
            pi: { sendMessage: (msg: { customType?: string }) => sent.push(msg) } as never,
            ctx: { ui: { notify: (m: string) => toasts.push(m) } } as never,
            job,
            timeoutMs: 15_000,
        });

        assert.equal(reg.pendingDecisionJobId, "job-timeout");
        // Claude Code just backgrounds on timeout — no steering message, no
        // forced turn. The bash tool's own result tells the agent; only a
        // human-facing toast fires here.
        assert.equal(sent.length, 0, "no sendMessage on timeout (CC parity)");
        assert.equal(toasts.length, 1);
        assert.match(toasts[0], /Backgrounded/);
        assert.match(toasts[0], /still running/);
    });
});

function makeCtx(notifications: string[] = []): UiContext {
    return {
        ui: {
            notify: (message) => notifications.push(message),
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_colour, text) => text },
            select: async () => undefined,
            editor: async () => undefined,
        },
    };
}

// Minimal pi stub exposing just the event bus completeJob touches.
function makeEventCapturingPi() {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const pi = {
        events: {
            emit(channel: string, data: unknown) { emitted.push({ channel, data }); },
            on() { return () => {}; },
        },
        // notifyFinished only reads pi.sendMessage; stub it as a no-op.
        sendMessage() {},
    };
    return { pi, emitted };
}

void describe("completeJob emits BG_TASK_FINISHED_EVENT", () => {
    void it("emits the terminal event on the bus with job details", () => {
        const reg = new BackgroundRegistry();
        const { pi, emitted } = makeEventCapturingPi();
        const job = makeJob({ id: "job-e-1", command: "echo hi", pid: 4242, kind: "shell", logPath: "/tmp/pi-bg/job-e-1.log", startTime: 1000 });
        reg.jobs.set(job.id, job);
        completeJob({ job, code: 0, reg, pi: pi as never, ctx: makeCtx() as never, shouldNotify: false });
        const ev = emitted.find((e) => e.channel === BG_TASK_FINISHED_EVENT);
        assert.ok(ev, "should emit BG_TASK_FINISHED_EVENT");
        const d = ev!.data as BgTaskFinishedEvent;
        assert.equal(d.jobId, "job-e-1");
        assert.equal(d.status, "completed");
        assert.equal(d.exitCode, 0);
        assert.equal(d.pid, 4242);
        assert.equal(d.kind, "shell");
        assert.equal(d.command, "echo hi");
    });

    void it("reports failed status + exit code for a non-zero exit", () => {
        const reg = new BackgroundRegistry();
        const { pi, emitted } = makeEventCapturingPi();
        const job = makeJob({ id: "job-e-2", pid: 7, logPath: "/tmp/pi-bg/job-e-2.log" });
        reg.jobs.set(job.id, job);
        completeJob({ job, code: 3, reg, pi: pi as never, ctx: makeCtx() as never, shouldNotify: false });
        const ev = emitted.find((e) => e.channel === BG_TASK_FINISHED_EVENT);
        const d = ev!.data as BgTaskFinishedEvent;
        assert.equal(d.status, "failed");
        assert.equal(d.exitCode, 3);
    });

    void it("does not emit for an already-terminal job (idempotent)", () => {
        const reg = new BackgroundRegistry();
        const { pi, emitted } = makeEventCapturingPi();
        const job = makeJob({ id: "job-e-3", status: "completed" });
        reg.jobs.set(job.id, job);
        completeJob({ job, code: 0, reg, pi: pi as never, ctx: makeCtx() as never, shouldNotify: false });
        assert.equal(emitted.filter((e) => e.channel === BG_TASK_FINISHED_EVENT).length, 0);
    });
});
