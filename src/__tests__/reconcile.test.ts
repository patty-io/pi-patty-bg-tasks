/**
 * reconcileJobs health check: finalize dead-PID jobs and kill alive-but-wedged
 * jobs so a `wait` tool never blocks forever. Deterministic — inject isAlive,
 * now, and lastActivityMs; assert the job leaves the live set (donePromise
 * resolves, status terminal).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { reconcileJobs, DEFAULT_STALE_JOB_MS } from "../reconcile.ts";
import { ensureCompletionPromise } from "../lifecycle.ts";
import { liveJobCount } from "../shared-live.ts";
import { markLive } from "../shared-live.ts";
import type { Job } from "../types.ts";

function runningJob(id: string, over: Partial<Job> = {}): Job {
    return {
        id, command: "x", pid: 4242, startTime: 1000,
        status: "running", logPath: "/tmp/none-" + id, toolCallId: id,
        isBackgrounded: true, ...over,
    } as Job;
}

function register(reg: BackgroundRegistry, job: Job) {
    ensureCompletionPromise(job);
    reg.jobs.set(job.id, job);
    markLive(job.id);
}

void describe("reconcileJobs", () => {
    void it("finalizes a job whose process is dead (leaves live set, resolves done)", async () => {
        const reg = new BackgroundRegistry();
        const job = runningJob("dead");
        register(reg, job);
        let resolved = false;
        job.donePromise!.then(() => { resolved = true; });

        reconcileJobs(reg, { isAlive: () => false, now: () => 5000, lastActivityMs: () => 5000 });

        assert.notEqual(job.status, "running", "dead job must become terminal");
        await Promise.resolve();
        assert.equal(resolved, true, "donePromise resolved so wait unblocks");
    });

    void it("kills an alive-but-wedged job (no output past the stale window)", async () => {
        const reg = new BackgroundRegistry();
        const job = runningJob("wedged", { startTime: 0 });
        register(reg, job);

        // Alive, but last activity was long ago (older than the stale window).
        reconcileJobs(reg, {
            isAlive: () => true,
            now: () => DEFAULT_STALE_JOB_MS + 10,
            lastActivityMs: () => 0,
        });
        assert.notEqual(job.status, "running", "wedged job is killed");
    });

    void it("leaves a healthy, recently-active job alone", () => {
        const reg = new BackgroundRegistry();
        const job = runningJob("healthy");
        register(reg, job);

        reconcileJobs(reg, {
            isAlive: () => true,
            now: () => 10_000,
            lastActivityMs: () => 9_000, // 1s ago — well within the window
        });
        assert.equal(job.status, "running", "healthy job keeps running");
    });

    void it("never treats a monitor job as wedged", () => {
        const reg = new BackgroundRegistry();
        const job = runningJob("mon", { kind: "monitor", startTime: 0 });
        register(reg, job);

        reconcileJobs(reg, {
            isAlive: () => true,
            now: () => DEFAULT_STALE_JOB_MS * 5,
            lastActivityMs: () => 0, // ancient, but it's a monitor
        });
        assert.equal(job.status, "running", "monitors are long-lived by design");
    });

    void it("dropping the job from the live set decrements liveJobCount", () => {
        const reg = new BackgroundRegistry();
        const before = liveJobCount();
        const job = runningJob("count");
        register(reg, job);
        assert.equal(liveJobCount(), before + 1);
        reconcileJobs(reg, { isAlive: () => false });
        assert.equal(liveJobCount(), before, "wait's live count drops after reconcile");
    });

    void it("can scope reconciliation to jobs owned by one session", () => {
        const reg = new BackgroundRegistry();
        const target = runningJob("target", { sessionId: "session-a" });
        const other = runningJob("other", { sessionId: "session-b" });
        register(reg, target);
        register(reg, other);

        reconcileJobs(reg, {
            isAlive: () => false,
            shouldReconcile: (job) => job.sessionId === "session-a",
        });

        assert.notEqual(target.status, "running");
        assert.equal(other.status, "running");
    });
});
