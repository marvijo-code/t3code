import type { CodexSettings, OpenCodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { probeCodexSkillsForCwd } from "../Layers/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../Layers/codexLaunchArgs.ts";
import { loadOpenCodeCommands, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import type { OpenCodeServerOwner } from "../OpenCodeServerOwner.ts";

/** Discover skills using the same home, environment and launch overrides as the adapter. */
export const loadCodexWorkspaceSkills = (
  config: CodexSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) =>
  probeCodexSkillsForCwd({
    binaryPath: config.binaryPath,
    homePath: config.homePath,
    launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
    cwd,
    environment,
  }).pipe(Effect.scoped, Effect.timeout("20 seconds"));

/** Use the shared SDK server so large inventories are not truncated by CLI stdout. */
export function makeOpenCodeWorkspaceLoader(
  effectiveConfig: OpenCodeSettings,
  processEnv: NodeJS.ProcessEnv,
  openCodeRuntime: OpenCodeRuntimeShape,
  serverOwner: OpenCodeServerOwner["Service"],
) {
  const loadWorkspaceInventory = (client: Parameters<typeof loadOpenCodeCommands>[0]) =>
    Effect.all(
      {
        skills: openCodeRuntime.loadOpenCodeSkills(client),
        commands: loadOpenCodeCommands(client).pipe(
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => []),
        ),
      },
      { concurrency: "unbounded" },
    );
  return (cwd: string) =>
    effectiveConfig.serverUrl.trim().length > 0
      ? Effect.scoped(
          Effect.gen(function* () {
            const server = yield* openCodeRuntime.connectToOpenCodeServer({
              binaryPath: effectiveConfig.binaryPath,
              directory: cwd,
              serverUrl: effectiveConfig.serverUrl,
              ...(effectiveConfig.serverPassword
                ? { serverPassword: effectiveConfig.serverPassword }
                : {}),
              environment: processEnv,
            });
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: cwd,
              ...(effectiveConfig.serverPassword
                ? { serverPassword: effectiveConfig.serverPassword }
                : {}),
            });
            return yield* loadWorkspaceInventory(client);
          }),
        )
      : serverOwner.withServer((server) =>
          loadWorkspaceInventory(
            openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: cwd,
              ...(server.serverPassword !== undefined
                ? { serverPassword: server.serverPassword }
                : {}),
            }),
          ),
        );
}
