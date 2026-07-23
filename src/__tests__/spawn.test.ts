// src/__tests__/spawn.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Will import from spawn.ts once created
// import { spawnWithFileOutput, killProcessTree, processExists } from "../spawn.ts";

const testDir = join(tmpdir(), `pi-bg-test-${process.pid}`);
const testShellPath = process.platform === "win32" ? "powershell.exe" : null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(25);
    }
    return predicate();
}

describe("buildShellInvocation", () => {
    test("keeps bash as the default shell", async () => {
        const { buildShellInvocation } = await import("../spawn.ts");
        assert.deepEqual(buildShellInvocation("echo ok", undefined, "win32"), {
            shell: "bash",
            args: ["-c", "echo ok"],
        });
    });

    test("uses non-interactive PowerShell arguments for pwsh", async () => {
        const { buildShellInvocation } = await import("../spawn.ts");
        const invocation = buildShellInvocation(
            "Write-Output ok",
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            "win32"
        );
        assert.equal(invocation.shell, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
        assert.deepEqual(invocation.args, [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Write-Output ok",
        ]);
    });

    test("uses cmd command arguments for cmd.exe", async () => {
        const { buildShellInvocation } = await import("../spawn.ts");
        assert.deepEqual(
            buildShellInvocation("echo ok", "C:\\Windows\\System32\\cmd.exe", "win32"),
            {
                shell: "C:\\Windows\\System32\\cmd.exe",
                args: ["/d", "/s", "/c", "echo ok"],
            }
        );
    });
});

describe("resolveConfiguredWindowsShellPath", () => {
    test("project shellPath overrides the global setting", async () => {
        const { resolveConfiguredWindowsShellPath } = await import("../spawn.ts");
        const root = join(testDir, "settings");
        const agentDir = join(root, "agent");
        const projectDir = join(root, "project");
        mkdirSync(join(projectDir, ".pi"), { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "global.exe" }));
        writeFileSync(
            join(projectDir, ".pi", "settings.json"),
            JSON.stringify({ shellPath: "project.exe" })
        );

        assert.equal(
            resolveConfiguredWindowsShellPath(projectDir, true, agentDir),
            "project.exe"
        );
        assert.equal(
            resolveConfiguredWindowsShellPath(projectDir, false, agentDir),
            "global.exe"
        );
        rmSync(root, { recursive: true, force: true });
    });
});

describe("spawnWithFileOutput", () => {
    test("captures stdout to log file", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-stdout.log");
        const result = spawnWithFileOutput({
            command: 'echo "hello world"',
            cwd: process.cwd(),
            logPath,
            shellPath: testShellPath,
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
            command: 'node -e "console.error(\'err msg\')"',
            cwd: process.cwd(),
            logPath,
            shellPath: testShellPath,
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
            shellPath: testShellPath,
        });
        const code = await result.exit;
        assert.equal(code, 42);
        try { unlinkSync(logPath); } catch {}
    });

    test("writes asynchronous spawn errors to the log", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-spawn-error.log");
        const result = spawnWithFileOutput({
            file: join(testDir, "definitely-missing-executable"),
            cwd: process.cwd(),
            logPath,
        });
        const code = await result.exit;
        assert.equal(code, 1);
        assert.match(readFileSync(logPath, "utf-8"), /Failed to spawn .*ENOENT/);
        unlinkSync(logPath);
    });

    test(
        "executes a configured cmd.exe",
        { skip: process.platform !== "win32" },
        async () => {
            const { spawnWithFileOutput } = await import("../spawn.ts");
            mkdirSync(testDir, { recursive: true });
            const logPath = join(testDir, "test-cmd.log");
            const result = spawnWithFileOutput({
                command: "echo cmd-ok",
                cwd: process.cwd(),
                logPath,
                shellPath: process.env.ComSpec ?? "cmd.exe",
            });
            assert.equal(await result.exit, 0);
            assert.match(readFileSync(logPath, "utf-8"), /cmd-ok/);
            unlinkSync(logPath);
        }
    );

    test(
        "executes a configured PowerShell",
        { skip: process.platform !== "win32" },
        async () => {
            const { spawnWithFileOutput } = await import("../spawn.ts");
            mkdirSync(testDir, { recursive: true });
            const logPath = join(testDir, "test-powershell.log");
            const result = spawnWithFileOutput({
                command: "Write-Output powershell-ok",
                cwd: process.cwd(),
                logPath,
                shellPath: "powershell.exe",
            });
            assert.equal(await result.exit, 0);
            assert.match(readFileSync(logPath, "utf-8"), /powershell-ok/);
            unlinkSync(logPath);
        }
    );

    test("respects AbortSignal", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-abort.log");
        const ac = new AbortController();
        const result = spawnWithFileOutput({
            command: 'node -e "setInterval(() => {}, 1000)"',
            cwd: process.cwd(),
            logPath,
            signal: ac.signal,
            shellPath: testShellPath,
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
            command:
                `node -e "const {spawn}=require('node:child_process'); ` +
                `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); ` +
                `console.log(child.pid); setInterval(()=>{},1000)"`,
            cwd: process.cwd(),
            logPath,
            shellPath: testShellPath,
        });
        assert.ok(
            await waitUntil(() => /^\d+/m.test(readFileSync(logPath, "utf-8"))),
            "child pid should be written"
        );
        const childPid = Number.parseInt(readFileSync(logPath, "utf-8").trim(), 10);
        assert.ok(processExists(result.pid));
        assert.ok(processExists(childPid));
        killProcessTree(result.pid);
        await result.exit;
        assert.ok(await waitUntil(() => !processExists(result.pid)));
        assert.ok(await waitUntil(() => !processExists(childPid)));
        try { unlinkSync(logPath); } catch {}
    });
});
