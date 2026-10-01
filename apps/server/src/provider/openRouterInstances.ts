/**
 * OpenRouter provider instances, as pure data transforms.
 *
 * An OpenRouter provider is an ordinary provider instance under a reserved id
 * (see `OPENROUTER_HARNESSES`). This module builds those instances from the
 * saved key and shapes their snapshots; it has no services.
 */
import {
  OPENROUTER_HARNESSES,
  resolveProviderInstanceEnabled,
  type OpenRouterConfigureInput,
  type OpenRouterHarness,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

export interface OpenRouterCatalogModel {
  readonly id: string;
  readonly name: string;
}

const OPENROUTER_CODEX_LAUNCH_TOKENS = [
  'model_provider="openrouter"',
  'model_providers.openrouter.name="OpenRouter"',
  'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
  'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
  'model_providers.openrouter.wire_api="responses"',
  "model_providers.openrouter.requires_openai_auth=false",
  "model_providers.openrouter.supports_websockets=false",
].map((value) => `-c '${value}'`);

export const OPENROUTER_CODEX_LAUNCH_ARGS = OPENROUTER_CODEX_LAUNCH_TOKENS.join(" ");

type OpenRouterHarnessDefinition = (typeof OPENROUTER_HARNESSES)[number];

const managedEnvironment = (
  harness: OpenRouterHarness,
  apiKey: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> =>
  harness === "claudeAgent"
    ? [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: apiKey, sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ]
    : [{ name: "OPENROUTER_API_KEY", value: apiKey, sensitive: true }];

const readConfigObject = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};

/**
 * Launch args with every OpenRouter routing token present. Checked per token,
 * so a user who edits one token gets it back without the rest duplicating.
 */
export const ensureOpenRouterCodexLaunchArgs = (launchArgs: string | undefined): string => {
  const existing = launchArgs?.trim() ?? "";
  const missing = OPENROUTER_CODEX_LAUNCH_TOKENS.filter((token) => !existing.includes(token));
  return [...missing, existing].filter((part) => part.length > 0).join(" ");
};

const withCodexLaunchArgs = (config: Record<string, unknown>): Record<string, unknown> => ({
  ...config,
  launchArgs: ensureOpenRouterCodexLaunchArgs(
    typeof config.launchArgs === "string" ? config.launchArgs : undefined,
  ),
});

function buildInstance(input: {
  readonly harness: OpenRouterHarnessDefinition;
  readonly existing: ProviderInstanceConfig | undefined;
  readonly apiKey: string;
  readonly enabled: boolean;
}): ProviderInstanceConfig {
  const { harness, existing, apiKey, enabled } = input;
  const managed = managedEnvironment(harness.harness, apiKey);
  const managedNames = new Set(managed.map((variable) => variable.name));
  const config = readConfigObject(existing?.config);
  return {
    driver: harness.driver,
    displayName: existing?.displayName ?? harness.displayName,
    ...(existing?.accentColor ? { accentColor: existing.accentColor } : {}),
    enabled,
    environment: [
      ...(existing?.environment ?? []).filter((variable) => !managedNames.has(variable.name)),
      // Without a key no copy of it may stay behind; the plain variables are harmless.
      ...managed.filter((variable) => apiKey.length > 0 || !variable.sensitive),
    ],
    config: harness.harness === "codex" ? withCodexLaunchArgs(config) : config,
  };
}

/**
 * The settings patch for one `server.configureOpenRouter` call. `current`
 * must be materialized settings (secrets in the clear): the key is copied
 * into each managed instance's environment.
 */
export function resolveOpenRouterSettingsPatch(
  current: ServerSettings,
  input: OpenRouterConfigureInput,
): ServerSettingsPatch {
  const apiKey = input.apiKey ?? current.openRouter.apiKey;
  const providerInstances: Record<string, ProviderInstanceConfig> = {
    ...current.providerInstances,
  };
  for (const harness of OPENROUTER_HARNESSES) {
    const existing = current.providerInstances[harness.instanceId];
    // The reserved id holds someone else's instance: never touch it.
    if (existing !== undefined && existing.driver !== harness.driver) continue;
    const wasEnabled = existing !== undefined && resolveProviderInstanceEnabled(existing);
    const enabled = apiKey.length > 0 && (input.harnesses?.[harness.harness] ?? wasEnabled);
    if (existing === undefined && !enabled) continue;
    providerInstances[harness.instanceId] = buildInstance({ harness, existing, apiKey, enabled });
  }
  return {
    openRouter: { apiKey },
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
}

const PREFERRED_VENDOR: Partial<Record<string, string>> = {
  codex: "openai/",
  claudeAgent: "anthropic/",
};

const toProviderModel = (
  model: OpenRouterCatalogModel,
  slugPrefix: string,
): ServerProviderModel => {
  const separator = model.name.indexOf(": ");
  const subProvider = separator > 0 ? model.name.slice(0, separator).trim() : "";
  return {
    slug: `${slugPrefix}${model.id}`,
    name: model.name,
    ...(subProvider ? { subProvider } : {}),
    isCustom: false,
    capabilities: null,
  };
};

const OPENCODE_SLUG_PREFIX = "openrouter/";

function catalogModelsForDriver(
  driver: ProviderDriverKind,
  nativeModels: ReadonlyArray<ServerProviderModel>,
  catalog: ReadonlyArray<OpenRouterCatalogModel>,
): ReadonlyArray<ServerProviderModel> {
  if (driver === "opencode") {
    // OpenCode rejects a model its own registry does not know, so list the
    // catalog models it reported, with the selectors it reported for them.
    const native = new Map(
      nativeModels
        .filter((model) => !model.isCustom && model.slug.startsWith(OPENCODE_SLUG_PREFIX))
        .map((model) => [model.slug, model] as const),
    );
    if (catalog.length === 0) return [...native.values()];
    const listed = catalog.map((model) => toProviderModel(model, OPENCODE_SLUG_PREFIX));
    if (native.size === 0) return listed;
    return listed.flatMap((model) => {
      const known = native.get(model.slug);
      return known ? [{ ...model, capabilities: known.capabilities }] : [];
    });
  }
  const vendor = PREFERRED_VENDOR[driver];
  const defaultId =
    vendor === undefined
      ? undefined
      : catalog.find((model) => model.id.startsWith(vendor) && !model.id.includes(":"))?.id;
  return catalog.map((model) =>
    model.id === defaultId
      ? { ...toProviderModel(model, ""), isDefault: true }
      : toProviderModel(model, ""),
  );
}

/**
 * Replace a managed instance's model list with OpenRouter's catalog and
 * describe its account as OpenRouter. Custom models are kept.
 */
export function applyOpenRouterCatalog<
  Draft extends Pick<
    ServerProvider,
    "models" | "auth" | "enabled" | "checkedAt" | "usageLimits" | "message"
  >,
>(driver: ProviderDriverKind, draft: Draft, catalog: ReadonlyArray<OpenRouterCatalogModel>): Draft {
  if (!draft.enabled && catalog.length === 0) return draft;
  const listed = catalogModelsForDriver(driver, draft.models, catalog);
  const listedSlugs = new Set(listed.map((model) => model.slug));
  const custom = draft.models.filter((model) => model.isCustom && !listedSlugs.has(model.slug));
  return {
    ...draft,
    models: [...listed, ...custom],
    auth:
      draft.auth.status === "unauthenticated"
        ? draft.auth
        : { ...draft.auth, type: "openrouter", label: "OpenRouter" },
    ...(draft.enabled
      ? {
          usageLimits: {
            checkedAt: draft.checkedAt,
            windows: [],
            unavailable: { reason: "unsupported" as const },
            externalUsage: { label: "OpenRouter activity", url: "https://openrouter.ai/activity" },
          },
        }
      : {}),
    ...(draft.enabled && draft.message === undefined && listed.length === 0
      ? { message: "Could not load the OpenRouter model list. Refresh provider status to retry." }
      : {}),
  };
}
