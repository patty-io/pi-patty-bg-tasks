/**
 * drainRunningJobs: blocks until running jobs finish, no-op when idle, bounded
 * by a timeout. Deterministic — jobs are plain registry entries whose
 * donePromise we resolve manually.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { drainRunningJobs } from "../drain.ts";
import { ensureCompletionPromise } from "../lifecycle.ts";
import type { Job } from "../types.ts";

function runningJob(id: string): Job {
    return {
        id, command: "x", pid: 1, startTime: Date.now(),
        status: "running", logPath: "/tmp/none", toolCallId: id, isBackgrounded: true,
    } as Job;
}

void describe("drainRunningJobs", () => {
    void it("returns immediately when no jobs are running", async () => {
        const reg = new BackgroundRegistry();
        const start = Date.now();
        await drainRunningJobs(reg, 5000);
        assert.ok(Date.now() - start < 200, "must be a no-op when nothing runs");
    });

    void it("blocks until a running job completes, then resolves", async () => {
        const reg = new BackgroundRegistry();
        const job = runningJob("j1");
        ensureCompletionPromise(job);
        reg.jobs.set(job.id, job);

        let resolved = false;
        const p = drainRunningJobs(reg, 5000).then(() => { resolved = true; });

        // Not resolved while the job is still running.
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(resolved, false, "drain must block while a job runs");

        // Completing the job resolves its donePromise → drain returns.
        job.status = "completed";
        job.resolveDone?.();
        await p;
        assert.equal(resolved, true);
    });

    void it("gives up after the timeout if a job never finishes", async () => {
        const reg = new BackgroundRegistry();
        const job = runningJob("stuck");
        ensureCompletionPromise(job);
        reg.jobs.set(job.id, job);

        const start = Date.now();
        await drainRunningJobs(reg, 40); // never resolve the job
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 40 && elapsed < 2000, `should return near the timeout, took ${elapsed}ms`);
    });

    void it("waits for ALL running jobs", async () => {
        const reg = new BackgroundRegistry();
        const a = runningJob("a"); const b = runningJob("b");
        for (const j of [a, b]) { ensureCompletionPromise(j); reg.jobs.set(j.id, j); }

        let done = false;
        const p = drainRunningJobs(reg, 5000).then(() => { done = true; });

        a.status = "completed"; a.resolveDone?.();
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(done, false, "still blocked while b runs");

        b.status = "completed"; b.resolveDone?.();
        await p;
        assert.equal(done, true);
    });
});
