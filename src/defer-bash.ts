/**
 * Deferred bash patching — lets pi-patty-bg-tasks coexist with display
 * extensions (pi-tool-display, etc.) that also register a "bash" tool.
 *
 * Strategy:
 *   pi-patty-bg-tasks does NOT call pi.registerTool({ name: "bash" }) during
 *   extension init, which avoids the init-time conflict detection
 *   (detectExtensionConflicts). Instead it monkey-patches the ExtensionRunner
 *   prototype so that when the tool registry is first built (during
 *   AgentSession._buildRuntime → _refreshToolRegistry →
 *   getAllRegisteredTools), it intercepts the bash tool definition and replaces
 *   its `execute` in-place with the backgrounding-aware version.
 *
 * Because the tool definition is patched by reference (same JS object), all
 * subsequent references via _toolDefinitions, _toolRegistry, and agent.state.tools
 * see the patched execute while the original renderCall/renderResult are preserved.
 *
 * If NO extension registers bash (e.g. tool-display is not installed), we add
 * our own bash definition — with patty's execute but Pi's built-in rendering
 * (renderCall/renderResult from createBashToolDefinition) — so the tool still
 * works without a display extension present.
 *
 * This means:
 *   - With display extension (e.g. tool-display) → its render, patty's execute
 *   - Without display extension          → built-in render, patty's execute
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { createBashExecute } from "./tools/bash.ts";

const PATCH_MARK = Symbol("patty-bash-execute-patched");

/**
 * Install the prototype patch. Call once during extension init.
 * After this, whenever getAllRegisteredTools runs, any bash tool definition
 * gets its execute replaced with the backgrounding-aware version.
 */
export function patchBashExecute(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
): void {
    const pattyExecute = createBashExecute(reg, pi);

    const origMethod = ExtensionRunner.prototype.getAllRegisteredTools;
    let fallbackDone = false;

    ExtensionRunner.prototype.getAllRegisteredTools = function () {
        const tools = origMethod.call(this);
        let foundBash = false;

        for (const entry of tools) {
            const def = entry.definition;
            if (def.name === "bash" && !(PATCH_MARK in def)) {
                // Mark first so re-entrant calls are safe
                Object.defineProperty(def, PATCH_MARK, {
                    value: true,
                    configurable: false,
                    enumerable: false,
                    writable: false,
                });
                // Replace execute in-place — renderCall/renderResult stay untouched
                def.execute = pattyExecute;
                foundBash = true;
            }
        }

        // No extension registered bash at all (no tool-display, etc.).
        // Add our own definition so patty's backgrounding still works.
        if (!foundBash && !fallbackDone) {
            fallbackDone = true;
            const bashDef = createBashToolDefinition(process.cwd());
            bashDef.execute = pattyExecute;
            Object.defineProperty(bashDef, PATCH_MARK, {
                value: true,
                configurable: false,
                enumerable: false,
                writable: false,
            });
            // _refreshToolRegistry only reads definition + sourceInfo
            tools.push({
                definition: bashDef,
                sourceInfo: { source: "pi-patty-bg-tasks" },
            } as any);
        }

        return tools;
    };
}
