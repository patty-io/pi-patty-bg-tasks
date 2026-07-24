import assert from "node:assert/strict";
import test from "node:test";
import { shouldRegisterBashOverride } from "../subagent.ts";

test("keeps Pi native bash in a process-mode subagent", () => {
    assert.equal(shouldRegisterBashOverride({ PI_SUBAGENT_CHILD: "1" }), false);
});

test("installs the background-aware bash override in ordinary sessions", () => {
    assert.equal(shouldRegisterBashOverride({}), true);
});
