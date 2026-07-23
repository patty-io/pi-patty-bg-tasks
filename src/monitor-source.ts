/**
 * A monitor's event source, behind one seam.
 *
 * Both kinds of monitor produce the same thing the session needs: a log file
 * whose appended lines are events, a promise that resolves when the source
 * ends, and a teardown hook. Naming that contract lets the session (see
 * monitor-session.ts) treat command and WebSocket monitors identically, and
 * makes a third source (named pipe, file replay, …) a drop-in later.
 */

import { spawnWithFileOutput } from "./spawn.ts";
import { openWsSource, type WsSpec } from "./monitor-ws.ts";

export interface MonitorSource {
    /** File the follower reads; appended lines become events. */
    logPath: string;
    /** OS pid backing the source, or 0 when there is no process (ws). */
    pid: number;
    /** Human-readable label shown in the sidebar / jobs list. */
    label: string;
    /** Resolves when the source ends (process exit code, or ws close code). */
    exit: Promise<number | null>;
    /** Teardown beyond the standard process kill (closes the ws socket). */
    stop: () => void;
}

/** Command source: a shell child whose stdout is the event stream and whose
 *  stderr is captured separately (readable, never emitted). */
export function spawnCommandSource(args: {
    command: string;
    cwd: string;
    logPath: string;
    errPath: string;
    projectTrusted?: boolean;
}): MonitorSource {
    const spawned = spawnWithFileOutput({
        command: args.command,
        cwd: args.cwd,
        logPath: args.logPath,
        errPath: args.errPath,
        projectTrusted: args.projectTrusted,
    });
    return {
        logPath: args.logPath,
        pid: spawned.pid,
        label: args.command,
        exit: spawned.exit,
        // The process group is killed by the standard kill path; nothing extra.
        stop: () => {},
    };
}

/** WebSocket source: each text frame is appended to the log as a line. */
export function openWsMonitorSource(spec: WsSpec, logPath: string): MonitorSource {
    const ws = openWsSource(spec, logPath);
    return {
        logPath,
        pid: 0,
        label: `ws ${spec.url}`,
        exit: ws.exit,
        stop: ws.close,
    };
}
