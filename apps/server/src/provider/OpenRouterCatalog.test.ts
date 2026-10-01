import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, FileSystem, Path, Deferred, Fiber, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { make, normalizeOpenRouterModels } from "./OpenRouterCatalog.ts";

const data = {
  data: [
    { id: "vendor/z", name: "Z" },
    { id: "vendor/a", name: "A", supported_parameters: ["tools"] },
    { id: "image/model", name: "Image", architecture: { output_modalities: ["image"] } },
    { id: "vendor/z", name: "Z" },
  ],
};
const dependencies = (handler: Parameters<typeof HttpClient.make>[0]) =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-openrouter-catalog-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler))),
  );

describe("OpenRouter catalog", () => {
  it("keeps raw text IDs, deduplicates, sorts, and chooses one tool-capable default", () => {
    const models = normalizeOpenRouterModels(data);
    assert.deepStrictEqual(
      models.map((m) => m.slug),
      ["vendor/a", "vendor/z"],
    );
    assert.deepStrictEqual(
      models.filter((m) => m.isDefault).map((m) => m.slug),
      ["vendor/a"],
    );
    assert.deepStrictEqual(models[0]?.capabilities, { optionDescriptors: [] });
    assert.deepStrictEqual(normalizeOpenRouterModels({ data: [] }), []);
  });
  it.effect(
    "fetches once across simultaneous harness checks, expires, backs off and retains stale data",
    () => {
      let calls = 0;
      let fail = false;
      return Effect.gen(function* () {
        const service = yield* make;
        assert.deepStrictEqual(yield* service.current, []);
        assert.strictEqual(calls, 0);
        const values = yield* Effect.all([service.refresh, service.refresh, service.refresh], {
          concurrency: 3,
        });
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(values[0], values[2]);
        yield* TestClock.adjust("59 minutes");
        yield* service.refresh;
        assert.strictEqual(calls, 1);
        yield* TestClock.adjust("1 minute");
        fail = true;
        assert.deepStrictEqual(yield* service.refresh, values[0]);
        assert.strictEqual(calls, 2);
        yield* service.refresh;
        assert.strictEqual(calls, 2);
        yield* TestClock.adjust("5 minutes");
        fail = false;
        yield* service.refresh;
        assert.strictEqual(calls, 3);
      }).pipe(
        Effect.provide(
          dependencies((request) => {
            calls++;
            assert.strictEqual(request.url, "https://openrouter.ai/api/v1/models");
            assert.isUndefined(request.headers.authorization);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                fail ? new Response("unavailable", { status: 503 }) : Response.json(data),
              ),
            );
          }),
        ),
      );
    },
  );
  it.effect("loads sanitized disk cache after restart and ignores invalid cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const cache = path.join(config.providerStatusCacheDir, "openrouter-models.json");
      yield* fs.makeDirectory(config.providerStatusCacheDir, { recursive: true });
      yield* fs.writeFileString(cache, "invalid");
      const first = yield* make;
      assert.deepStrictEqual(yield* first.current, []);
      const models = yield* first.refresh;
      const document = yield* fs.readFileString(cache);
      assert.notInclude(document, "Authorization");
      const next = yield* make;
      assert.deepStrictEqual(yield* next.current, models);
      assert.deepStrictEqual(yield* next.refresh, models);
    }).pipe(
      Effect.provide(
        dependencies((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(data))),
        ),
      ),
    ),
  );
  it.effect("publishes only content changes and coalesces concurrent explicit refresh", () => {
    let calls = 0;
    let changed = false;
    return Effect.gen(function* () {
      const service = yield* make;
      yield* service.refresh;
      const subscription = yield* service.subscribeChanges;
      const received = yield* Deferred.make<ReadonlyArray<string>>();
      const fiber = yield* subscription.pipe(
        Stream.take(1),
        Stream.runForEach((models) =>
          Deferred.succeed(
            received,
            models.map((m) => m.slug),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Effect.all([service.forceRefresh, service.forceRefresh, service.forceRefresh], {
        concurrency: 3,
      });
      assert.strictEqual(calls, 2);
      changed = true;
      yield* service.forceRefresh;
      assert.strictEqual(calls, 3);
      assert.deepStrictEqual(yield* Deferred.await(received), ["vendor/new"]);
      yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(
        dependencies((request) => {
          calls++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(changed ? { data: [{ id: "vendor/new", name: "New" }] } : data),
            ),
          );
        }),
      ),
    );
  });
  it.effect("ignores malformed upstream and retains usable memory on disk-write failure", () => {
    let malformed = true;
    return Effect.gen(function* () {
      const service = yield* make;
      assert.deepStrictEqual(yield* service.refresh, []);
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      yield* fs.makeDirectory(config.providerStatusCacheDir, { recursive: true });
      // A directory at the target makes atomic replacement fail, without mocking the filesystem.
      yield* fs.makeDirectory(`${config.providerStatusCacheDir}/openrouter-models.json`, {
        recursive: true,
      });
      malformed = false;
      const models = yield* service.forceRefresh;
      assert.strictEqual(models.length, 2);
      assert.deepStrictEqual(yield* service.current, models);
    }).pipe(
      Effect.provide(
        dependencies((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(malformed ? { data: [{ id: "", name: "Bad" }] } : data),
            ),
          ),
        ),
      ),
    );
  });
});
