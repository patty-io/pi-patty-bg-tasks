export function shouldRegisterBashOverride(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.PI_SUBAGENT_CHILD !== "1";
}
