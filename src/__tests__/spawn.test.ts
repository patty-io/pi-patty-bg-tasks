// src/__tests__/spawn.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Will import from spawn.ts once created
// import { spawnWithFileOutput, killProcessTree, processExists } from "../spawn.ts";

const testDir = join(tmpdir(), `pi-bg-test-${process.pid}`);

describe("spawnWithFileOutput", () => {
    test("captures stdout to log file", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-stdout.log");
        const result = spawnWithFileOutput({
            command: 'echo "hello world"',
            cwd: process.cwd(),
            logPath,
            keepRef: true,
        });
        assert.ok(result.pid > 0);
        const code = await result.exit;
        assert.equal(code, 0);
        const output = readFileSync(logPath, "utf-8");
        assert.ok(output.includes("hello world"));
        unlinkSync(logPath);
    });

    test("captures stderr to same log file", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-stderr.log");
        const result = spawnWithFileOutput({
            command: 'echo "err msg" >&2',
            cwd: process.cwd(),
            logPath,
            keepRef: true,
        });
        const code = await result.exit;
        assert.equal(code, 0);
        const output = readFileSync(logPath, "utf-8");
        assert.ok(output.includes("err msg"));
        unlinkSync(logPath);
    });

    test("returns non-zero exit code on failure", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-fail.log");
        const result = spawnWithFileOutput({
            command: "exit 42",
            cwd: process.cwd(),
            logPath,
            keepRef: true,
        });
        const code = await result.exit;
        assert.equal(code, 42);
        try { unlinkSync(logPath); } catch {}
    });

    test("respects AbortSignal", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-abort.log");
        const ac = new AbortController();
        const result = spawnWithFileOutput({
            command: "sleep 60",
            cwd: process.cwd(),
            logPath,
            signal: ac.signal,
            keepRef: true,
        });
        // Give process time to start
        await new Promise((r) => setTimeout(r, 200));
        ac.abort();
        const code = await result.exit;
        // Killed process returns non-zero or null
        assert.ok(code !== 0);
        try { unlinkSync(logPath); } catch {}
    });
});

describe("killProcessTree", () => {
    test("kills a running process", async () => {
        const { spawnWithFileOutput, killProcessTree, processExists } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-kill.log");
        const result = spawnWithFileOutput({
            command: "sleep 60",
            cwd: process.cwd(),
            logPath,
            keepRef: true,
        });
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(processExists(result.pid));
        killProcessTree(result.pid);
        await result.exit;
        // After exit, process should be gone (give OS a moment)
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(!processExists(result.pid));
        try { unlinkSync(logPath); } catch {}
    });
});
