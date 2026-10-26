import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBlockedSleep, detectJobLogPoll, SLEEP_WAIT_GUIDANCE } from "../lifecycle.ts";
import { BackgroundRegistry } from "../state.ts";
import { registerBashBgTool } from "../tools/bash-bg.ts";

void describe("detectBlockedSleep — naive-wait detection", () => {
    void it("blocks a standalone long sleep", () => {
        assert.equal(detectBlockedSleep("sleep 600"), "sleep 600");
        assert.equal(detectBlockedSleep("sleep 2"), "sleep 2");
    });

    void it("blocks an EMBEDDED top-level sleep (the lingering-job case)", () => {
        // cd is first, so the old leading-only check missed this.
        assert.equal(
            detectBlockedSleep("cd /repo; sleep 600; cat log; echo done"),
            "sleep 600"
        );
        assert.equal(detectBlockedSleep("build && sleep 5 && test"), "sleep 5");
        assert.equal(detectBlockedSleep("cd x || sleep 30"), "sleep 30");
    });

    void it("blocks a newline-separated sleep (bash's primary separator)", () => {
        assert.equal(detectBlockedSleep("npm run dev &\nsleep 5\ncurl localhost:3000"), "sleep 5");
        assert.equal(detectBlockedSleep("make\nsleep 30\nmake test"), "sleep 30");
    });

    void it("blocks a backgrounded sleep (sleep 600 &)", () => {
        assert.equal(detectBlockedSleep("sleep 600 &"), "sleep 600");
        assert.equal(detectBlockedSleep("start; sleep 600 &\ncheck"), "sleep 600");
    });

    void it("blocks minute/hour/day durations regardless of number", () => {
        assert.equal(detectBlockedSleep("sleep 5m"), "sleep 5m");
        assert.equal(detectBlockedSleep("setup; sleep 1h; check"), "sleep 1h");
    });

    void it("allows sub-2s and float sleeps (deliberate pacing)", () => {
        assert.equal(detectBlockedSleep("sleep 1"), null);
        assert.equal(detectBlockedSleep("sleep 0.5"), null);
        assert.equal(detectBlockedSleep("cmd; sleep 1; cmd"), null);
    });

    void it("NEVER flags a sleep inside a polling loop (the correct pattern)", () => {
        assert.equal(detectBlockedSleep("until grep -q READY log; do sleep 1; done"), null);
        assert.equal(detectBlockedSleep("while ! curl -sf localhost; do sleep 5; done"), null);
        assert.equal(detectBlockedSleep("for i in 1 2 3; do work; sleep 5; done"), null);
    });

    void it("does not flag a sleep inside a pipeline or subshell", () => {
        assert.equal(detectBlockedSleep("sleep 5 | tee x"), null);
        assert.equal(detectBlockedSleep("(sleep 5; cmd)"), null);
    });

    void it("allows commands with no sleep", () => {
        assert.equal(detectBlockedSleep("npm run build && npm test"), null);
        assert.equal(detectBlockedSleep("echo sleeping; echo done"), null);
    });
});

void describe("bash_bg — rejects a backgrounded sleep wait", () => {
    function bashBg() {
        let tool: { execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown> } | undefined;
        const pi = { registerTool: (def: typeof tool) => { tool = def; }, sendMessage() {} };
        registerBashBgTool(pi as never, new BackgroundRegistry());
        const ctx = {
            cwd: process.cwd(),
            ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c: string, t: string) => t } },
        };
        return { tool: tool!, ctx };
    }

    void it("blocks an embedded sleep in bash_bg (previously unguarded)", async () => {
        const { tool, ctx } = bashBg();
        await assert.rejects(
            () => tool.execute("t1", { command: "cd /repo; sleep 600; cat log" }, undefined, undefined, ctx),
            /Blocked: sleep 600.*jobs action='attach'/s
        );
    });

    void it("still allows a real backgrounded command", async () => {
        const { tool, ctx } = bashBg();
        const res = await tool.execute("t2", { command: "echo hi" }, undefined, undefined, ctx);
        assert.ok(res, "non-sleep command runs");
    });
});

void describe("detectJobLogPoll — foreground loop over this extension's own log (#32)", () => {
    void it("blocks the loop that hung a turn", () => {
        assert.equal(
            detectJobLogPoll("until grep -q DONE /tmp/pi-bg/job-123.log; do sleep 0.5; done"),
            "a foreground loop polling a background job's log"
        );
        assert.equal(
            detectJobLogPoll("while :; do sleep 5; tail -1 /tmp/pi-bg/job-9.log; done"),
            "a foreground loop polling a background job's log"
        );
        // The incident's shape: a loop whose only exit is the job's own success
        // signature, so a dead target looks exactly like "not ready yet".
        assert.ok(
            detectJobLogPoll(
                "until grep -q BGDONE \"$PI_BG_LOG\"; do sleep 0.5; done"
            )
        );
    });

    void it("allows one-shot reads and loops over other files", () => {
        assert.equal(detectJobLogPoll("cat /tmp/pi-bg/job-1.log"), null);
        assert.equal(detectJobLogPoll("tail -n 40 /tmp/pi-bg/job-1.log"), null);
        assert.equal(detectJobLogPoll("until grep -q READY build.log; do sleep 1; done"), null);
        assert.equal(detectJobLogPoll("echo /tmp/pi-bg/"), null);
        // A loop that never sleeps cannot burn a turn on a dead target.
        assert.equal(detectJobLogPoll("until test -f /tmp/pi-bg/x.log; do :; done"), null);
    });

    void it("is enforced by bash_bg as well", async () => {
        let tool:
            | { execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown> }
            | undefined;
        const pi = { registerTool: (def: typeof tool) => { tool = def; }, sendMessage() {} };
        registerBashBgTool(pi as never, new BackgroundRegistry());
        const ctx = {
            cwd: process.cwd(),
            ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c: string, t: string) => t } },
        };
        await assert.rejects(
            () =>
                tool!.execute(
                    "t1",
                    { command: "until grep -q DONE /tmp/pi-bg/job-1.log; do sleep 0.5; done" },
                    undefined,
                    undefined,
                    ctx
                ),
            /Blocked: a foreground loop polling a background job's log\..*completion notification/s
        );
    });
});

void describe("SLEEP_WAIT_GUIDANCE — ordered, no unbounded recipe (#32)", () => {
    void it("leads with ending the turn and the completion notification", () => {
        const firstBullet = SLEEP_WAIT_GUIDANCE.split("\n")[1] ?? "";
        assert.match(firstBullet, /completion notification/);
        assert.doesNotMatch(firstBullet, /attach/);
    });

    void it("no longer ships the never-converging until example", () => {
        assert.doesNotMatch(SLEEP_WAIT_GUIDANCE, /until grep -q READY log; do sleep 0\.5; done/);
        // The replacement example must match a failure signature, not only success.
        assert.match(SLEEP_WAIT_GUIDANCE, /READY\|error\|Traceback/);
    });

    void it("tells the agent attach is bounded and re-attachable", () => {
        assert.match(SLEEP_WAIT_GUIDANCE, /wait cap — attach again/);
    });
});
