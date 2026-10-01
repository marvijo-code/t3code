import { expandHomePath } from "../pathExpansion.ts";
import { CODEX_PRESENTATION } from "./Layers/CodexProvider.ts";
import { CLAUDE_PRESENTATION } from "./Layers/ClaudeProvider.ts";
import { OPENCODE_PRESENTATION } from "./Layers/OpenCodeProvider.ts";
import {
  loadCodexWorkspaceSkills,
  makeOpenCodeWorkspaceLoader,
} from "./Drivers/workspaceInventory.ts";
import { discoverClaudeSkills } from "./Drivers/ClaudeSkills.ts";
import {
  openCodeSkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
} from "./Layers/OpenCodeProvider.ts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { MINIMUM_OPENCODE_VERSION } from "./opencodeRuntime.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import { OpenCodeRuntime } from "./opencodeRuntime.ts";
import {
  ClaudeSettings,
  CodexSettings,
  OpenCodeSettings,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../config.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import { makeClaudeTextGeneration } from "../textGeneration/ClaudeTextGeneration.ts";
import { makeOpenCodeTextGeneration } from "../textGeneration/OpenCodeTextGeneration.ts";
import { ProviderDriverError } from "./Errors.ts";
import { withInstanceIdentity } from "./Drivers/instanceIdentity.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { makeCodexAdapter } from "./Layers/CodexAdapter.ts";
import { makeClaudeAdapter } from "./Layers/ClaudeAdapter.ts";
import { makeOpenCodeAdapter } from "./Layers/OpenCodeAdapter.ts";
import { ProviderEventLoggers } from "./Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";
import { OpenRouterCatalog } from "./OpenRouterCatalog.ts";
import { make as makeServerOwner, OpenCodeServerOwner } from "./OpenCodeServerOwner.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "./ProviderDriver.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
} from "./providerSnapshot.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";

const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaude = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeOpenCode = Schema.decodeUnknownEffect(OpenCodeSettings);

export const OPENROUTER_CODEX_ARGS = [
  'model_provider="openrouter"',
  'model_providers.openrouter.name="OpenRouter"',
  'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
  'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
  'model_providers.openrouter.wire_api="responses"',
  "model_providers.openrouter.requires_openai_auth=false",
  "model_providers.openrouter.supports_websockets=false",
]
  .map((value) => `-c '${value}'`)
  .join(" ");

/** Runtime for the three managed backends, sharing the server's catalog and lifecycle. */
export const makeOpenRouterProvider = Effect.fnUntraced(function* (
  driverKind: ProviderDriverKind,
  input: ProviderDriverCreateInput<unknown>,
) {
  const { instanceId, displayName, accentColor, enabled } = input;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const catalog = yield* OpenRouterCatalog;
  const manifest = yield* ModelManifest.ModelManifest;

  const loggers = yield* ProviderEventLoggers;
  const homePath = path.join(config.stateDir, "provider-homes", instanceId);
  const env = { ...mergeProviderInstanceEnvironment(input.environment) };
  const codexConfig = yield* decodeCodex({
    ...(input.config as object),
    setupMode: "existing",
    homePath,
    launchArgs: OPENROUTER_CODEX_ARGS,
    enabled,
  }).pipe(Effect.orDie);
  const claudeConfig = yield* decodeClaude({ ...(input.config as object), homePath, enabled }).pipe(
    Effect.orDie,
  );
  const opencode = yield* decodeOpenCode({
    ...(input.config as object),
    serverUrl: "",
    enabled,
  }).pipe(Effect.orDie);
  const codex = { ...codexConfig, binaryPath: expandHomePath(codexConfig.binaryPath) };
  const claude = { ...claudeConfig, binaryPath: expandHomePath(claudeConfig.binaryPath) };
  const presentation =
    driverKind === "codex"
      ? CODEX_PRESENTATION
      : driverKind === "claudeAgent"
        ? CLAUDE_PRESENTATION
        : OPENCODE_PRESENTATION;
  const binaryPath =
    driverKind === "codex"
      ? codex.binaryPath
      : driverKind === "claudeAgent"
        ? claude.binaryPath
        : opencode.binaryPath;
  if (driverKind !== "opencode")
    yield* fs.makeDirectory(homePath, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new ProviderDriverError({
            driver: driverKind,
            instanceId,
            detail: "Could not create the OpenRouter harness home.",
          }),
      ),
    );
  if (driverKind === "codex") {
    env.CODEX_HOME = homePath;
    env.T3CODE_CODEX_LAUNCH_ARGS = OPENROUTER_CODEX_ARGS;
  }
  if (driverKind === "claudeAgent") Object.assign(env, yield* makeClaudeEnvironment(claude, env));
  const keySet = Boolean(
    env[driverKind === "claudeAgent" ? "ANTHROPIC_AUTH_TOKEN" : "OPENROUTER_API_KEY"],
  );
  const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
  const stamp = withInstanceIdentity({
    instanceId,
    driverKind,
    displayName,
    accentColor,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
    resolveProviderMaintenanceCapabilitiesEffect(
      makePackageManagedProviderMaintenanceResolver({
        provider: driverKind,
        npmPackageName:
          driverKind === "codex"
            ? "@openai/codex"
            : driverKind === "claudeAgent"
              ? "@anthropic-ai/claude-code"
              : "opencode-ai",
        nativeUpdate: { args: ["update"], isCommandPath: () => false },
      }),
      { binaryPath, env },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    ),
  );
  const check = Effect.gen(function* () {
    const models = yield* enabled && keySet ? catalog.refresh : catalog.current;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!enabled || !keySet)
      return stamp(
        buildServerProvider({
          enabled: false,
          checkedAt,
          models,
          presentation: { ...presentation, displayName: displayName ?? "OpenRouter" },
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unauthenticated" },
          },
        }),
      );
    const probe = yield* Effect.gen(function* () {
      const command = yield* resolveSpawnCommand(binaryPath, ["--version"], { env });
      const result = yield* spawnAndCollect(
        binaryPath,
        ChildProcess.make(command.command, command.args, { shell: command.shell, env }),
      );
      return {
        installed: true,
        version: parseGenericCliVersion(result.stdout),
        ok: result.code === 0,
      };
    }).pipe(
      Effect.timeout("4 seconds"),
      Effect.catch((error) =>
        Effect.succeed({ installed: !isCommandMissingCause(error), version: null, ok: false }),
      ),
    );
    const tooOld =
      driverKind === "opencode" &&
      (!probe.version || compareSemverVersions(probe.version, MINIMUM_OPENCODE_VERSION) < 0);
    const snapshot = stamp(
      buildServerProvider({
        enabled,
        checkedAt,
        models,
        driver: driverKind,
        presentation: {
          ...presentation,
          displayName: displayName ?? "OpenRouter",
        },
        probe: {
          installed: probe.installed,
          version: probe.version,
          status: probe.ok && !tooOld && models.length ? "ready" : "error",
          auth: { status: "authenticated", type: "apiKey", label: "OpenRouter (configured)" },
          ...(tooOld
            ? { message: `OpenRouter requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.` }
            : !probe.ok
              ? {
                  message:
                    "OpenRouter requires an installed harness executable. Check its executable path.",
                }
              : !models.length
                ? {
                    message:
                      "OpenRouter models could not be loaded. Refresh providers to try again.",
                  }
                : {}),
        },
      }),
    );
    return applyProviderCompatibility(
      snapshot,
      (yield* manifest.current).compatibility,
      ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
    );
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const catalogChanges = yield* catalog.subscribeChanges;
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance,
    getSettings: Effect.succeed(enabled),
    streamSettings: catalogChanges.pipe(Stream.map(() => enabled)),
    haveSettingsChanged: () => true,
    initialSnapshot: () => check,
    checkProvider: check,
  }).pipe(
    Effect.mapError(
      () =>
        new ProviderDriverError({
          driver: driverKind,
          instanceId,
          detail: "Could not build the OpenRouter provider.",
        }),
    ),
  );
  const models = catalog.current;
  const modelCatalog = models.pipe(
    Effect.map((records) => ({
      models: records.map((model) => ({ model, runtime: {}, compatibility: {} })),
    })),
  );
  const adapterOptions = {
    instanceId,
    environment: env,
    ...(loggers.native ? { nativeEventLogger: loggers.native } : {}),
  };
  let loadOpenCodeWorkspace: ReturnType<typeof makeOpenCodeWorkspaceLoader> | undefined;
  const runtime =
    driverKind === "codex"
      ? {
          adapter: yield* makeCodexAdapter(codex, { ...adapterOptions, models }),
          textGeneration: yield* makeCodexTextGeneration(
            codex,
            env,
            models,
            undefined,
            "openrouter",
          ),
        }
      : driverKind === "claudeAgent"
        ? {
            adapter: yield* makeClaudeAdapter(claude, { ...adapterOptions, modelCatalog }),
            textGeneration: yield* makeClaudeTextGeneration(claude, env, modelCatalog),
          }
        : yield* Effect.gen(function* () {
            const runtime = yield* Effect.serviceOption(OpenCodeRuntime);
            if (Option.isNone(runtime))
              return yield* new ProviderDriverError({
                driver: driverKind,
                instanceId,
                detail: "OpenCode runtime is unavailable.",
              });
            const owner = yield* makeServerOwner({
              binaryPath,
              directory: config.cwd,
              environment: env,
            }).pipe(Effect.provideService(OpenCodeRuntime, runtime.value));
            loadOpenCodeWorkspace = makeOpenCodeWorkspaceLoader(
              opencode,
              env,
              runtime.value,
              owner,
            );
            return {
              adapter: yield* makeOpenCodeAdapter(opencode, {
                ...adapterOptions,
                modelProvider: "openrouter",
              }).pipe(Effect.provideService(OpenCodeRuntime, runtime.value)),
              textGeneration: yield* makeOpenCodeTextGeneration(opencode, "openrouter").pipe(
                Effect.provideService(OpenCodeServerOwner, owner),
                Effect.provideService(OpenCodeRuntime, runtime.value),
              ),
            };
          });
  return {
    instanceId,
    driverKind,
    displayName,
    accentColor,
    enabled,
    continuationIdentity,
    snapshot,
    snapshotForCwd: (cwd: string) =>
      !enabled || !keySet
        ? snapshot.getSnapshot
        : Effect.gen(function* () {
            const machineSnapshot = yield* snapshot.getSnapshot;
            if (driverKind === "codex") {
              const skills = yield* loadCodexWorkspaceSkills(codex, cwd, env).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
              return { ...machineSnapshot, skills };
            }
            if (driverKind === "claudeAgent") {
              const skills = yield* discoverClaudeSkills(claude, cwd, env).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
              return { ...machineSnapshot, skills };
            }
            const { skills, commands } = yield* loadOpenCodeWorkspace!(cwd).pipe(
              Effect.timeout("20 seconds"),
            );
            return {
              ...machineSnapshot,
              skills: openCodeSkillsToServerProviderSkills(skills),
              slashCommands: openCodeCommandsToServerProviderSlashCommands(commands),
            };
          }).pipe(
            Effect.mapError(
              () =>
                new ProviderDriverError({
                  driver: driverKind,
                  instanceId,
                  detail: `Failed to discover workspace inventory for '${cwd}'.`,
                }),
            ),
          ),
    ...runtime,
  } satisfies ProviderInstance;
});
