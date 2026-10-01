import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { testOpenRouterConnection } from "./OpenRouterConnection.ts";

const sentinel = "distinctive-openrouter-secret";
const run = (status: number, body: unknown) =>
  testOpenRouterConnection.pipe(
    Effect.provide(ServerSettingsService.layerTest({ openRouter: { apiKey: sentinel } })),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        assert.strictEqual(request.url, "https://openrouter.ai/api/v1/key");
        assert.strictEqual(request.headers.authorization, `Bearer ${sentinel}`);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
      }),
    ),
  );

describe("OpenRouter key check", () => {
  it.effect("accepts valid and nullable remaining limits using the saved key", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run(200, { data: { limit_remaining: 12.5 } }), {
        success: true,
        limitRemaining: 12.5,
      });
      assert.deepStrictEqual(yield* run(200, { data: { limit_remaining: null } }), {
        success: true,
        limitRemaining: null,
      });
    }),
  );
  for (const [status, code] of [
    [401, "rejectedKey"],
    [403, "rejectedKey"],
    [429, "rateLimited"],
    [500, "upstream"],
    [200, "malformed"],
  ] as const) {
    it.effect(`sanitizes HTTP ${status} ${code}`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(run(status, { secret: sentinel }));
        assert.strictEqual(error.code, code);
        assert.notInclude(JSON.stringify(error), sentinel);
      }),
    );
  }
  it.effect("does not send a request without a saved key", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(testOpenRouterConnection);
      assert.strictEqual(error.code, "missingKey");
    }).pipe(
      Effect.provide(ServerSettingsService.layerTest()),
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected network")),
        ),
      ),
    ),
  );
  it.effect("sanitizes network errors without serializing the authorization request", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        testOpenRouterConnection.pipe(
          Effect.provide(ServerSettingsService.layerTest({ openRouter: { apiKey: sentinel } })),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new Error(sentinel),
                  }),
                }),
              ),
            ),
          ),
        ),
      );
      assert.strictEqual(error.code, "network");
      assert.notInclude(JSON.stringify(error), sentinel);
    }),
  );
  it.effect("bounds the saved-key request with a ten-second timeout", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const check = yield* testOpenRouterConnection.pipe(
        Effect.provide(ServerSettingsService.layerTest({ openRouter: { apiKey: sentinel } })),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Deferred.await(requested);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(check);
      assert.strictEqual(error.code, "network");
      assert.notInclude(JSON.stringify(error), sentinel);
    }),
  );
});
