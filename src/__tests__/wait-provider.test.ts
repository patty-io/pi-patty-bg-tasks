import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerWaitProvider } from "../wait-provider.ts";
import { BackgroundRegistry } from "../state.ts";
import { add } from "../registry.ts";
import { BG_TASK_FINISHED_EVENT, type Job } from "../types.ts";

const REGISTRY_KEY = "pi-subagents.background-work.v1";

interface TestProvider {
    name: string;
    listActiveWork(): readonly { id: string; sessionId: string }[];
    wakeChannels?: readonly string[];
    reconcile?(context: { sessionId: string; nowMs: number }): void;
}

interface TestRegistry {
    version: 1;
    providers: Map<string, TestProvider>;
}

function clearProviderRegistry(): void {
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(REGISTRY_KEY)];
}

function providerRegistry(): TestRegistry {
    return (globalThis as Record<PropertyKey, unknown>)[Symbol.for(REGISTRY_KEY)] as TestRegistry;
}

function runningJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-1",
        command: "echo hi",
        pid: process.pid,
        startTime: Date.now(),
        status: "running",
        logPath: "/tmp/pi-patty-wait-provider-test.log",
        toolCallId: "tc-1",
        isBackgrounded: true,
        ...overrides,
    };
}

beforeEach(clearProviderRegistry);
afterEach(clearProviderRegistry);

void describe("registerWaitProvider", () => {
    void it("publishes pi-subagents v1 provider metadata and active job identities", () => {
        const reg = new BackgroundRegistry();
        reg.currentSessionId = "session-a";
        const dispose = registerWaitProvider(reg);

        const store = providerRegistry();
        assert.equal(store.version, 1);
        assert.ok(store.providers instanceof Map);

        const provider = store.providers.get("pi-patty-bg-tasks");
        assert.ok(provider);
        assert.deepEqual(provider.wakeChannels, [BG_TASK_FINISHED_EVENT]);

        add(reg, runningJob({ id: "job-a" }));
        add(reg, runningJob({ id: "job-b", sessionId: "session-b" }));
        add(reg, runningJob({ id: "done", status: "completed" }));
        reg.jobs.set("missing-session", runningJob({ id: "missing-session", sessionId: undefined }));

        assert.deepEqual(provider.listActiveWork(), [
            { id: "job-a", sessionId: "session-a" },
            { id: "job-b", sessionId: "session-b" },
        ]);

        dispose();
        assert.equal(store.providers.has("pi-patty-bg-tasks"), false);
    });

    void it("old disposer cannot remove a replacement provider after extension reload", () => {
        const first = new BackgroundRegistry();
        const second = new BackgroundRegistry();

        const disposeFirst = registerWaitProvider(first);
        const firstProvider = providerRegistry().providers.get("pi-patty-bg-tasks");
        assert.ok(firstProvider);

        const disposeSecond = registerWaitProvider(second);
        const secondProvider = providerRegistry().providers.get("pi-patty-bg-tasks");
        assert.ok(secondProvider);
        assert.notEqual(secondProvider, firstProvider);

        disposeFirst();
        assert.equal(providerRegistry().providers.get("pi-patty-bg-tasks"), secondProvider);

        disposeSecond();
        assert.equal(providerRegistry().providers.has("pi-patty-bg-tasks"), false);
    });
});
