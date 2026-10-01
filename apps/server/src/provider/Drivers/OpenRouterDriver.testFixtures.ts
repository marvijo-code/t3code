import { HttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Stream } from "effect";
import {
  EnvironmentId,
  OPENROUTER_HARNESSES,
  ServerSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { CodexInstallation } from "../CodexInstallation.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { OpenRouterCatalog } from "../OpenRouterCatalog.ts";
import {
  materializeOpenRouterInstances,
  reconcileOpenRouterSettings,
} from "../OpenRouterSettings.ts";

export const modelSlug = "test-vendor/raw-model";
export const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: modelSlug,
    name: "Test model",
    isCustom: false,
    isDefault: true,
    capabilities: { optionDescriptors: [] },
  },
];
export const OpenRouterDriverTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-openrouter-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.mock(ServerSecretStore)({})),
  Layer.provideMerge(Layer.mock(CodexInstallation)({ managedDirectory: "unused" })),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("openrouter-test-environment")),
    }),
  ),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unexpected HTTP request")),
    ),
  ),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(OpenRouterCatalog, {
      current: Effect.succeed(models),
      refresh: Effect.succeed(models),
      forceRefresh: Effect.succeed(models),
      subscribeChanges: Effect.succeed(Stream.empty),
    }),
  ),
);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
export function runtimeEntry(driver: "codex" | "claudeAgent" | "opencode", binaryPath: string) {
  const harness = OPENROUTER_HARNESSES.find((h) => h.driver === driver)!;
  const initial = decodeSettings({
    openRouter: { apiKey: "driver-sentinel-key" },
    providers: { [driver]: { binaryPath } },
  });
  const enabled = reconcileOpenRouterSettings(
    { ...initial, openRouter: { ...initial.openRouter, [harness.setting]: true } },
    initial,
  );
  return {
    instanceId: harness.instanceId,
    ...materializeOpenRouterInstances(enabled, models)[harness.instanceId]!,
  };
}
