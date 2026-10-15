/**
 * `resolvePiBinary` — agent_bg's pi-binary resolution order: env override
 * PI_PATTY_PI_BINARY (trimmed, non-empty), else a standalone pi executable
 * (execPath basename pi / pi.exe, case-insensitive), else `which pi`
 * falling back to "pi".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePiBinary, type PiBinaryDeps } from "../tools/agent-bg.ts";

/** Fake deps: no override, node execPath, a `which` hit. */
function deps(over: Partial<PiBinaryDeps> = {}): PiBinaryDeps {
    return {
        env: {},
        execPath: "/usr/local/bin/node",
        which: () => "/usr/local/bin/pi",
        ...over,
    };
}

void describe("resolvePiBinary", () => {
    void it("prefers the env override and trims it", () => {
        assert.equal(
            resolvePiBinary(deps({ env: { PI_PATTY_PI_BINARY: "  pi-bolt  " }, execPath: "/opt/pi/bin/pi" })),
            "pi-bolt"
        );
    });

    void it("ignores a blank or whitespace-only override", () => {
        assert.equal(resolvePiBinary(deps({ env: { PI_PATTY_PI_BINARY: "" } })), "/usr/local/bin/pi");
        assert.equal(resolvePiBinary(deps({ env: { PI_PATTY_PI_BINARY: " \t " } })), "/usr/local/bin/pi");
    });

    void it("re-launches a standalone pi executable (basename pi / pi.exe, case-insensitive)", () => {
        for (const execPath of ["/opt/pi/bin/pi", "/opt/pi/bin/pi.exe", "/opt/pi/bin/PI.EXE", "/opt/pi/bin/Pi"]) {
            assert.equal(resolvePiBinary(deps({ execPath })), execPath);
        }
    });

    void it("falls through to `which` for a non-pi execPath", () => {
        assert.equal(resolvePiBinary(deps({ execPath: "/usr/local/bin/node" })), "/usr/local/bin/pi");
        assert.equal(resolvePiBinary(deps({ execPath: "/opt/bin/pi-bolt" })), "/usr/local/bin/pi");
    });

    void it("falls back to \"pi\" when `which` fails", () => {
        assert.equal(
            resolvePiBinary(deps({ which: () => { throw new Error("no which"); } })),
            "pi"
        );
        assert.equal(resolvePiBinary(deps({ which: () => "" })), "pi");
    });

    void it("never calls `which` when the override or execPath rule matches", () => {
        const mustNotBeCalled = () => { throw new Error("must not be called"); };
        assert.equal(
            resolvePiBinary(deps({ env: { PI_PATTY_PI_BINARY: "pi-bolt" }, which: mustNotBeCalled })),
            "pi-bolt"
        );
        assert.equal(
            resolvePiBinary(deps({ execPath: "/opt/pi/bin/pi", which: mustNotBeCalled })),
            "/opt/pi/bin/pi"
        );
    });
});
