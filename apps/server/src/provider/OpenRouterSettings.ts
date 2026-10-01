import {
  OPENROUTER_HARNESSES,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const encodeConfig = Schema.encodeSync(Schema.UnknownFromJsonString);

export const OPENROUTER_SECRET = "openrouter-api-key";
export const isOpenRouterInstance = (id: string, entry: ProviderInstanceConfig | undefined) =>
  entry?.integration === "openrouter" &&
  OPENROUTER_HARNESSES.some((h) => h.instanceId === id && h.driver === entry.driver);

const binaryPath = (config: unknown): string | undefined =>
  Predicate.isObject(config) && Predicate.isString(config.binaryPath)
    ? config.binaryPath
    : undefined;

/** Reconcile managed fields while preserving unrelated instances and executable corrections. */
export function reconcileOpenRouterSettings(next: ServerSettings, current = next): ServerSettings {
  const openRouter = { ...next.openRouter };
  const hasKey = openRouter.apiKey.length > 0;
  if (!hasKey) {
    openRouter.codex = false;
    openRouter.claudeCode = false;
    openRouter.openCode = false;
    if (
      OPENROUTER_HARNESSES.some((h) => next.openRouter[h.setting] && !current.openRouter[h.setting])
    ) {
      throw new ServerSettingsError({
        settingsPath: "<memory>",
        operation: "normalize",
        cause: undefined,
        detail: "Save an OpenRouter API key before enabling a harness.",
      });
    }
  }
  const providerInstances = { ...next.providerInstances };
  for (const h of OPENROUTER_HARNESSES) {
    const previous = current.providerInstances[h.instanceId];
    const candidate = providerInstances[h.instanceId];
    const owned = isOpenRouterInstance(h.instanceId, previous);
    if (!owned && (previous || candidate) && openRouter[h.setting]) {
      throw new ServerSettingsError({
        settingsPath: "<memory>",
        operation: "normalize",
        cause: undefined,
        detail: `OpenRouter instance ID ${h.instanceId} is already in use.`,
      });
    }
    if (!owned && !openRouter[h.setting]) {
      // A client cannot claim integration ownership by submitting a marker.
      if (isOpenRouterInstance(h.instanceId, candidate)) {
        if (previous) providerInstances[h.instanceId] = previous;
        else delete providerInstances[h.instanceId];
      }
      continue;
    }
    providerInstances[h.instanceId] = {
      driver: ProviderDriverKind.make(h.driver),
      integration: "openrouter",
      displayName: h.name,
      enabled: openRouter[h.setting],
      config: {
        binaryPath:
          (owned
            ? (binaryPath(candidate?.config) ?? binaryPath(previous?.config))
            : (binaryPath(current.providerInstances[ProviderInstanceId.make(h.driver)]?.config) ??
              current.providers[h.driver].binaryPath)) ??
          (h.driver === "claudeAgent" ? "claude" : h.driver),
        ...(h.driver === "codex" ? { setupMode: "existing" } : {}),
        ...(h.driver === "opencode" ? { serverUrl: "" } : {}),
      },
    };
  }
  return { ...next, openRouter, providerInstances };
}

/** Inject the single shared secret only into runtime envelopes. */
export function materializeOpenRouterInstances(
  settings: ServerSettings,
  models: ReadonlyArray<ServerProviderModel>,
) {
  const entries = { ...settings.providerInstances };
  for (const h of OPENROUTER_HARNESSES) {
    const entry = entries[h.instanceId];
    if (!isOpenRouterInstance(h.instanceId, entry) || !entry) continue;
    const key =
      settings.openRouter.apiKey === "\u2022\u2022\u2022\u2022\u2022\u2022"
        ? ""
        : settings.openRouter.apiKey;
    const credential = (name: string) => ({ name, value: key, sensitive: true });
    const environment =
      h.driver === "claudeAgent"
        ? [
            { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            credential("ANTHROPIC_AUTH_TOKEN"),
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: true },
            ...[
              "CLAUDE_CODE_USE_BEDROCK",
              "CLAUDE_CODE_USE_VERTEX",
              "CLAUDE_CODE_USE_FOUNDRY",
              "CLAUDE_CODE_OAUTH_TOKEN",
            ].map((name) => ({ name, value: "", sensitive: true })),
          ]
        : [credential("OPENROUTER_API_KEY")];
    if (h.driver === "opencode")
      environment.push({
        name: "OPENCODE_CONFIG_CONTENT",
        sensitive: false,
        value: encodeConfig({
          enabled_providers: ["openrouter"],
          provider: {
            openrouter: {
              options: {
                apiKey: "{env:OPENROUTER_API_KEY}",
                baseURL: "https://openrouter.ai/api/v1",
              },
              models: Object.fromEntries(models.map((m) => [m.slug, { name: m.name }])),
            },
          },
        }),
      });
    entries[h.instanceId] = {
      ...entry,
      enabled: Boolean(key) && entry.enabled !== false,
      environment,
    };
  }
  return entries;
}
