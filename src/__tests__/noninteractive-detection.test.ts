/**
 * resolveNonInteractive: prefer Pi's authoritative ctx.hasUI over argv/TTY
 * sniffing, so patty's non-interactive gating matches the real run mode (and
 * pi-subagents) across every entry path — including `pi --stream` piped from
 * stdin, `--print=true`, and aliases that a bare `-p` argv check misses.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveNonInteractive, detectNonInteractive } from "../lifecycle.ts";

describe("resolveNonInteractive (hasUI is source of truth)", () => {
    it("hasUI=true → interactive, regardless of argv/TTY", () => {
        assert.equal(resolveNonInteractive(true, ["pi"], true), false);
        assert.equal(resolveNonInteractive(true, ["pi", "-p", "x"], true), false, "TUI wins even if -p present");
        assert.equal(resolveNonInteractive(true, ["pi", "--stream"], false), false);
    });

    it("hasUI=false → non-interactive, regardless of argv/TTY", () => {
        assert.equal(resolveNonInteractive(false, ["pi"], true), true, "no -p but no UI (e.g. --stream via TTY-less print) → non-interactive");
        assert.equal(resolveNonInteractive(false, ["pi", "-p", "x"], false), true);
        assert.equal(resolveNonInteractive(false, ["pi", "--stream"], false), true);
    });

    it("covers the --stream-without-p case hasUI resolves but argv sniffing misses", () => {
        // `pi --stream "prompt"` piped from stdin: no -p in argv, but not a TUI.
        const argv = ["pi", "--stream", "prompt"];
        // Old argv+TTY path (fallback) would only catch it via the non-TTY branch:
        assert.equal(detectNonInteractive(argv, /*stdinIsTTY*/ true), false, "argv sniffing alone misses --stream under a TTY");
        // hasUI resolves it correctly:
        assert.equal(resolveNonInteractive(false, argv, true), true);
    });

    it("falls back to argv/TTY detection when hasUI is unavailable", () => {
        assert.equal(resolveNonInteractive(undefined, ["pi", "-p", "x"], true), true);
        assert.equal(resolveNonInteractive(undefined, ["pi"], true), false);
        assert.equal(resolveNonInteractive(undefined, ["pi"], false), true, "non-TTY stdin → non-interactive");
    });
});
