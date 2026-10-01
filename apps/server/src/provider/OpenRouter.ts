/**
 * OpenRouter - the saved key, its per-harness provider instances, and the
 * model catalog those instances list.
 *
 * The catalog is process-wide: one fetch serves every OpenRouter instance.
 * It is refreshed only while an enabled OpenRouter instance is probed, so an
 * environment without OpenRouter never contacts it.
 */
import {
  isOpenRouterInstance,
  type OpenRouterConfigureInput,
  type OpenRouterConnectionTestInput,
  type OpenRouterConnectionTestResult,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "../serverSettings.ts";
import {
  applyOpenRouterCatalog,
  resolveOpenRouterSettingsPatch,
  type OpenRouterCatalogModel,
} from "./openRouterInstances.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

/** How long a fetched catalog stays fresh before the next probe re-fetches. */
const CATALOG_TTL_MS = 60 * 60 * 1000;
/** Minimum gap between fetch attempts after a failure. */
const CATALOG_RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
      supported_parameters: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    }),
  ),
});
const decodeModelsResponse = Schema.decodeUnknownEffect(ModelsResponse);

const KeyResponse = Schema.Struct({
  data: Schema.Struct({
    label: Schema.optional(Schema.NullOr(Schema.String)),
    usage: Schema.optional(Schema.NullOr(Schema.Number)),
    limit: Schema.optional(Schema.NullOr(Schema.Number)),
    limit_remaining: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});
const decodeKeyResponse = Schema.decodeUnknownEffect(KeyResponse);

const CatalogCacheFile = Schema.fromJsonString(
  Schema.Struct({
    fetchedAtMs: Schema.Number,
    models: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }),
);
const decodeCatalogCache = Schema.decodeUnknownEffect(CatalogCacheFile);
const encodeCatalogCache = Schema.encodeEffect(CatalogCacheFile);

/** Tool-capable models only: a coding harness cannot drive the rest. */
function toCatalogModels(
  response: typeof ModelsResponse.Type,
): ReadonlyArray<OpenRouterCatalogModel> {
  const seen = new Set<string>();
  const models: OpenRouterCatalogModel[] = [];
  for (const entry of response.data) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    if (entry.supported_parameters && !entry.supported_parameters.includes("tools")) continue;
    seen.add(id);
    models.push({ id, name: entry.name?.trim() || id });
  }
  return models;
}

export const OPENROUTER_PROVIDER_AUTH = {
  status: "unknown",
  type: "openrouter",
  label: "OpenRouter",
} as const satisfies ServerProvider["auth"];

export class OpenRouter extends Context.Service<
  OpenRouter,
  {
    /** Catalog already in memory or on disk. Never fetches. */
    readonly current: Effect.Effect<ReadonlyArray<OpenRouterCatalogModel>>;
    /** Catalog after a TTL-gated fetch. Never fails; a failed fetch keeps the last good list. */
    readonly models: Effect.Effect<ReadonlyArray<OpenRouterCatalogModel>>;
    /** Marks the catalog stale so the next `models` refetches. Keeps the last good list. */
    readonly invalidateModels: Effect.Effect<void>;
    /** Applies key and harness changes. Returns settings already redacted for a client. */
    readonly configure: (
      input: OpenRouterConfigureInput,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly testConnection: (
      input: OpenRouterConnectionTestInput,
    ) => Effect.Effect<OpenRouterConnectionTestResult, ServerSettingsError>;
  }
>()("t3/provider/OpenRouter") {}

type OpenRouterDraft = Pick<
  ServerProvider,
  "models" | "auth" | "enabled" | "checkedAt" | "usageLimits" | "message"
>;

/** What a driver needs to present one instance, managed by OpenRouter or not. */
interface OpenRouterInstanceSupport {
  readonly managed: boolean;
  /** For pending and disabled snapshots: uses the catalog at hand, never the network. */
  readonly pending: <Draft extends OpenRouterDraft>(draft: Draft) => Effect.Effect<Draft>;
  /** For probe results: refreshes the catalog first when the instance is enabled. */
  readonly checked: <Draft extends OpenRouterDraft>(draft: Draft) => Effect.Effect<Draft>;
  readonly invalidate: Effect.Effect<void>;
  readonly continuationKey: (key: string) => string;
}

const UNMANAGED_INSTANCE: OpenRouterInstanceSupport = {
  managed: false,
  pending: Effect.succeed,
  checked: Effect.succeed,
  invalidate: Effect.void,
  continuationKey: (key) => key,
};

export function instanceSupport(
  service: OpenRouter["Service"],
  input: { readonly instanceId: ProviderInstanceId; readonly driverKind: ProviderDriverKind },
): OpenRouterInstanceSupport {
  if (!isOpenRouterInstance(input.instanceId, input.driverKind)) return UNMANAGED_INSTANCE;
  return {
    managed: true,
    pending: (draft) =>
      service.current.pipe(
        Effect.map((catalog) => applyOpenRouterCatalog(input.driverKind, draft, catalog)),
      ),
    checked: (draft) =>
      (draft.enabled ? service.models : service.current).pipe(
        Effect.map((catalog) => applyOpenRouterCatalog(input.driverKind, draft, catalog)),
      ),
    invalidate: service.invalidateModels,
    // A thread must never continue across backends (an Anthropic or OpenAI
    // session resumed through OpenRouter, or the reverse).
    continuationKey: (key) => `${key}:openrouter`,
  };
}

export const layerTest = (models: ReadonlyArray<OpenRouterCatalogModel> = []) =>
  Layer.succeed(OpenRouter, {
    current: Effect.succeed(models),
    models: Effect.succeed(models),
    invalidateModels: Effect.void,
    configure: () => Effect.die("OpenRouter.configure is not available in this test"),
    testConnection: () => Effect.die("OpenRouter.testConnection is not available in this test"),
  });

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;

  const cachePath = path.join(config.stateDir, "openrouter-models.json");
  let catalog: ReadonlyArray<OpenRouterCatalogModel> = [];
  let fetchedAtMs: number | null = null;
  let lastAttemptMs: number | null = null;
  const refreshSemaphore = yield* Semaphore.make(1);
  const configureSemaphore = yield* Semaphore.make(1);
  // One key probe at a time, so the endpoint cannot be used to hammer OpenRouter.
  const testSemaphore = yield* Semaphore.make(1);

  const ensureDiskCacheLoaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap((raw) => decodeCatalogCache(raw)),
      Effect.map((cached) => {
        catalog = cached.models;
        fetchedAtMs = cached.fetchedAtMs;
      }),
      Effect.ignoreCause,
    ),
  );

  const refresh = Effect.fn("OpenRouter.refreshModels")(function* () {
    yield* ensureDiskCacheLoaded;
    const now = yield* Clock.currentTimeMillis;
    // A timestamp in the future means the wall clock moved backwards; treat it as expired.
    const isWithin = (sinceMs: number | null, windowMs: number) =>
      sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;
    if (isWithin(fetchedAtMs, CATALOG_TTL_MS)) return catalog;
    if (isWithin(lastAttemptMs, CATALOG_RETRY_MS)) return catalog;

    lastAttemptMs = now;
    // The endpoint is public: the catalog must not depend on, or send, the key.
    const fetched = yield* httpClient.get(OPENROUTER_MODELS_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap((json) => decodeModelsResponse(json)),
      Effect.map(toCatalogModels),
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) return catalog;

    catalog = fetched;
    fetchedAtMs = now;
    yield* encodeCatalogCache({ fetchedAtMs: now, models: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(cachePath, serialized)),
      Effect.ignoreCause,
    );
    return catalog;
  });

  const configure = (input: OpenRouterConfigureInput) =>
    configureSemaphore.withPermits(1)(
      Effect.gen(function* () {
        // Materialized settings: the key is copied into each managed instance.
        const current = yield* serverSettings.getSettings;
        const updated = yield* serverSettings.updateSettings(
          resolveOpenRouterSettingsPatch(current, input),
        );
        return redactServerSettingsForClient(updated);
      }),
    );

  const testConnection = Effect.fn("OpenRouter.testConnection")(function* (
    input: OpenRouterConnectionTestInput,
  ) {
    const draft = input.apiKey ?? "";
    const apiKey = draft.length > 0 ? draft : (yield* serverSettings.getSettings).openRouter.apiKey;
    if (apiKey.length === 0) {
      return {
        status: "error",
        reason: "missing-key",
        message: "Save an OpenRouter API key first.",
      } satisfies OpenRouterConnectionTestResult;
    }
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(OPENROUTER_KEY_URL).pipe(HttpClientRequest.bearerToken(apiKey)),
      )
      .pipe(
        Effect.timeout(FETCH_TIMEOUT_MS),
        Effect.catchCause(() => Effect.succeed(null)),
      );
    if (response === null) {
      return {
        status: "error",
        reason: "unreachable",
        message: "Could not reach OpenRouter. Check the network connection and try again.",
      } satisfies OpenRouterConnectionTestResult;
    }
    const status = response.status;
    if (status === 401 || status === 403) {
      return {
        status: "error",
        reason: "invalid-key",
        message: "OpenRouter rejected this key. Check the key and try again.",
      } satisfies OpenRouterConnectionTestResult;
    }
    if (status !== 200) {
      return {
        status: "error",
        reason: "unreachable",
        message: `OpenRouter answered with HTTP ${status}.`,
      } satisfies OpenRouterConnectionTestResult;
    }
    const key = yield* response.json.pipe(
      Effect.flatMap((json) => decodeKeyResponse(json)),
      Effect.option,
    );
    const data = Option.isSome(key) ? key.value.data : undefined;
    return {
      status: "ok",
      label: data?.label ?? null,
      usage: data?.usage ?? null,
      limit: data?.limit ?? null,
      limitRemaining: data?.limit_remaining ?? null,
    } satisfies OpenRouterConnectionTestResult;
  });

  return OpenRouter.of({
    current: ensureDiskCacheLoaded.pipe(Effect.map(() => catalog)),
    models: refreshSemaphore.withPermits(1)(refresh()),
    invalidateModels: Effect.sync(() => {
      fetchedAtMs = null;
      lastAttemptMs = null;
    }),
    configure,
    testConnection: (input) => testSemaphore.withPermits(1)(testConnection(input)),
  });
});

export const layer = Layer.effect(OpenRouter, make);
