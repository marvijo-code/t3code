/**
 * OpenRouter provider instances, as pure data transforms.
 *
 * An OpenRouter provider is an ordinary provider instance under a reserved id
 * (see `OPENROUTER_HARNESSES`). This module builds those instances from the
 * saved key and shapes their snapshots; it has no services.
 */
import {
  isOpenRouterInstance,
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
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export interface OpenRouterCatalogModel {
  readonly id: string;
  readonly name: string;
}

const OPENROUTER_CODEX_CONFIG = [
  'model_provider="openrouter"',
  'model_providers.openrouter.name="OpenRouter"',
  'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
  'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
  'model_providers.openrouter.wire_api="responses"',
  "model_providers.openrouter.requires_openai_auth=false",
  "model_providers.openrouter.supports_websockets=false",
];

export const OPENROUTER_CODEX_LAUNCH_ARGS = OPENROUTER_CODEX_CONFIG.map(
  (value) => `-c '${value}'`,
).join(" ");

/**
 * Settings that would undo OpenRouter routing for Claude Code if a user set
 * them for the whole machine: another cloud backend, or a subscription login
 * that outranks ANTHROPIC_AUTH_TOKEN. Empty values switch them off for this
 * instance only.
 */
const COMPETING_CLAUDE_VARIABLES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

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
        ...COMPETING_CLAUDE_VARIABLES.map((name) => ({ name, value: "", sensitive: false })),
      ]
    : [{ name: "OPENROUTER_API_KEY", value: apiKey, sensitive: true }];

const readConfigObject = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};

const CODEX_CONFIG_FLAGS = new Set(["-c", "--config"]);

/** A `-c` value this module owns: the provider choice and the openrouter provider table. */
const isRoutingConfig = (value: string): boolean => {
  const separator = value.indexOf("=");
  const key = (separator < 0 ? value : value.slice(0, separator)).trim();
  return key === "model_provider" || key.startsWith("model_providers.openrouter");
};

/** Quotes one argument so `tokenizeCliArgs` reads it back unchanged. */
const quoteCliArg = (arg: string): string => {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  if (!arg.includes("'")) return `'${arg}'`;
  return `"${arg.replace(/["\\$`]/g, "\\$&")}"`;
};

/**
 * Launch args that always route through OpenRouter. Codex applies `-c`
 * overrides in order, so any routing override the user or operator passed
 * (for example `-c model_provider="openai"`) is dropped and OpenRouter's
 * settings go last. Every other argument is kept in place.
 */
export const ensureOpenRouterCodexLaunchArgs = (launchArgs: string | undefined): string => {
  const args = tokenizeCliArgs(launchArgs);
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (CODEX_CONFIG_FLAGS.has(arg) && index + 1 < args.length) {
      const value = args[index + 1]!;
      index++;
      if (!isRoutingConfig(value)) kept.push(arg, value);
      continue;
    }
    const inline = /^(?:-c|--config)=([\s\S]*)$/.exec(arg);
    if (inline && isRoutingConfig(inline[1]!)) continue;
    kept.push(arg);
  }
  return [...kept.map(quoteCliArg), OPENROUTER_CODEX_LAUNCH_ARGS].join(" ");
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
  const previous = new Map(
    (existing?.environment ?? []).map((variable) => [variable.name, variable]),
  );
  // An unchanged variable stays the same entry, so the settings service sees no
  // change and leaves its stored secret alone instead of writing it again.
  const keepUnchanged = (variable: ProviderInstanceEnvironmentVariable) => {
    const before = previous.get(variable.name);
    return before !== undefined &&
      before.value === variable.value &&
      before.sensitive === variable.sensitive
      ? before
      : variable;
  };
  const config = readConfigObject(existing?.config);
  return {
    driver: harness.driver,
    integration: "openrouter",
    displayName: existing?.displayName ?? harness.displayName,
    ...(existing?.accentColor ? { accentColor: existing.accentColor } : {}),
    enabled,
    environment: [
      ...(existing?.environment ?? []).filter((variable) => !managedNames.has(variable.name)),
      // Without a key no copy of it may stay behind; the plain variables are harmless.
      ...managed.filter((variable) => apiKey.length > 0 || !variable.sensitive).map(keepUnchanged),
    ],
    config: harness.harness === "codex" ? withCodexLaunchArgs(config) : config,
  };
}

/**
 * The settings patch for one `server.configureOpenRouter` call. `current`
 * must be materialized settings (secrets in the clear): the key is copied
 * into each managed instance's environment.
 *
 * Only instances OpenRouter setup created are changed. A user's own instance
 * that already holds a reserved id (any driver, no `integration` marker) is
 * left exactly as it is, and that harness stays unavailable until it is renamed.
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
    if (existing !== undefined && !isOpenRouterInstance(harness.instanceId, existing)) continue;
    const wasEnabled = existing !== undefined && resolveProviderInstanceEnabled(existing);
    const enabled = apiKey.length > 0 && (input.harnesses?.[harness.harness] ?? wasEnabled);
    if (existing === undefined && !enabled) continue;
    providerInstances[harness.instanceId] = buildInstance({ harness, existing, apiKey, enabled });
  }
  return {
    // An unchanged key is not sent back, so the secret store is not rewritten.
    ...(input.apiKey === undefined ? {} : { openRouter: { apiKey } }),
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
}

/**
 * Keeps the server in charge of the `integration` marker: a settings patch
 * from a client can neither claim an instance for OpenRouter nor drop the
 * marker from one it manages (as long as the driver is unchanged).
 */
export function preserveIntegrationMarkers(
  current: Pick<ServerSettings, "providerInstances">,
  next: ServerSettings,
): ServerSettings {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = { ...next.providerInstances };
  for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
    const previous = (current.providerInstances as Record<string, ProviderInstanceConfig>)[
      instanceId
    ];
    const owned = previous?.driver === instance.driver ? previous.integration : undefined;
    if (instance.integration === owned) continue;
    changed = true;
    const { integration: _ignored, ...rest } = instance;
    providerInstances[instanceId] = owned === undefined ? rest : { ...rest, integration: owned };
  }
  return changed
    ? { ...next, providerInstances: providerInstances as ServerSettings["providerInstances"] }
    : next;
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
