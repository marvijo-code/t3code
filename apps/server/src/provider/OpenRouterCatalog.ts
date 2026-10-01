import { ServerProviderModel, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

const UpstreamModels = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      name: TrimmedNonEmptyString,
      architecture: Schema.optionalKey(
        Schema.Struct({ output_modalities: Schema.optionalKey(Schema.Array(Schema.String)) }),
      ),
      supported_parameters: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
const encodeModels = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ServerProviderModel)));
const CacheDocument = Schema.Struct({
  version: Schema.Literal(1),
  fetchedAt: Schema.Number,
  models: Schema.Array(ServerProviderModel),
});

const decodeCache = Schema.decodeUnknownEffect(Schema.fromJsonString(CacheDocument));
const decodeUpstreamModels = Schema.decodeUnknownEffect(UpstreamModels);
const encodeCache = Schema.encodeSync(Schema.fromJsonString(CacheDocument));

export function normalizeOpenRouterModels(
  input: typeof UpstreamModels.Type,
): ReadonlyArray<ServerProviderModel> {
  const entries = [
    ...new Map(
      input.data
        .filter(
          (m) =>
            !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"),
        )
        .map((m) => [m.id, m]),
    ).values(),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const defaultId =
    entries.find((m) => m.supported_parameters?.includes("tools"))?.id ?? entries[0]?.id;
  return entries.map((m) => ({
    slug: m.id,
    name: m.name,
    isCustom: false,
    isDefault: m.id === defaultId,
    capabilities: { optionDescriptors: [] },
  }));
}

export class OpenRouterCatalog extends Context.Service<
  OpenRouterCatalog,
  {
    readonly current: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
    readonly refresh: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
    readonly forceRefresh: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
    readonly subscribeChanges: Effect.Effect<
      Stream.Stream<ReadonlyArray<ServerProviderModel>>,
      never,
      Scope.Scope
    >;
  }
>()("t3/provider/OpenRouterCatalog") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const http = yield* HttpClient.HttpClient;
  const cachePath = path.join(config.providerStatusCacheDir, "openrouter-models.json");
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<ServerProviderModel>>(),
    PubSub.shutdown,
  );
  const semaphore = yield* Semaphore.make(1);
  let models: ReadonlyArray<ServerProviderModel> = [];
  let fetchedAt: number | null = null;
  let attemptedAt: number | null = null;
  let attemptVersion = 0;
  const load = yield* Effect.cached(
    fs.readFileString(cachePath).pipe(
      Effect.flatMap(decodeCache),
      Effect.tap((cached) =>
        Effect.sync(() => {
          models = cached.models;
          fetchedAt = cached.fetchedAt;
        }),
      ),
      Effect.ignoreCause,
    ),
  );
  const refresh = Effect.fnUntraced(function* (force: boolean, requestedVersion: number) {
    yield* load;
    const now = yield* Clock.currentTimeMillis;
    const within = (since: number | null, ttl: number) =>
      since !== null && now >= since && now - since < ttl;
    // Concurrent explicit refreshes join the attempt completed after their request started.
    if (force && attemptVersion !== requestedVersion) return models;
    if (!force && (within(fetchedAt, 3600000) || within(attemptedAt, 300000))) return models;
    attemptedAt = now;
    const result = yield* http.get("https://openrouter.ai/api/v1/models").pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((r) => r.json),
      Effect.flatMap(decodeUpstreamModels),
      Effect.map(normalizeOpenRouterModels),
      Effect.timeout("10 seconds"),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    attemptVersion++;
    if (result === null) return models;
    const changed = encodeModels(result) !== encodeModels(models);
    models = result;
    fetchedAt = now;
    yield* writeFileStringAtomically({
      filePath: cachePath,
      contents: encodeCache({ version: 1, fetchedAt, models }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.ignoreCause,
    );
    if (changed) yield* PubSub.publish(changes, models);
    return models;
  });
  const run = (force: boolean) =>
    Effect.sync(() => attemptVersion).pipe(
      Effect.flatMap((version) => semaphore.withPermits(1)(refresh(force, version))),
    );
  return OpenRouterCatalog.of({
    current: load.pipe(Effect.map(() => models)),
    refresh: run(false),
    forceRefresh: run(true),
    subscribeChanges: PubSub.subscribe(changes).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });
});
export const layer = Layer.effect(OpenRouterCatalog, make);
export const layerTest = Layer.succeed(OpenRouterCatalog, {
  current: Effect.succeed([]),
  refresh: Effect.succeed([]),
  forceRefresh: Effect.succeed([]),
  subscribeChanges: Effect.succeed(Stream.empty),
});
