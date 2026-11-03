// @effect-diagnostics preferSchemaOverJson:off - Mock HTTP responses use JSON fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { make } from "./OpenRouter.ts";

interface Seen {
  readonly url: string;
  readonly authorization: string | undefined;
}

const layers = (input: {
  readonly prefix: string;
  readonly respond: (request: Seen) => Response | "network-error";
  readonly seen: Seen[];
}) =>
  ServerSettings.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: input.prefix })),
    ),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const seen = { url: request.url, authorization: request.headers.authorization };
          input.seen.push(seen);
          const response = input.respond(seen);
          return response === "network-error"
            ? Effect.die("network down")
            : Effect.succeed(HttpClientResponse.fromWeb(request, response));
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const MODELS = {
  data: [
    { id: "anthropic/model-a", name: "Anthropic: Model A", supported_parameters: ["tools"] },
    { id: "vendor/no-tools", name: "Vendor: No Tools", supported_parameters: ["max_tokens"] },
    { id: "openai/model-b", name: "OpenAI: Model B" },
  ],
};

describe("OpenRouter catalog", () => {
  it.effect("fetches once, without the key, then serves the cache until the TTL passes", () => {
    const seen: Seen[] = [];
    return Effect.gen(function* () {
      const service = yield* make;
      assert.deepStrictEqual(yield* service.current, []);
      const models = yield* service.models;
      assert.deepStrictEqual(
        models.map((model) => model.id),
        ["anthropic/model-a", "openai/model-b"],
      );
      yield* service.models;
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0]!.url, "https://openrouter.ai/api/v1/models");
      assert.isUndefined(seen[0]!.authorization);
      yield* TestClock.adjust("61 minutes");
      yield* service.models;
      assert.strictEqual(seen.length, 2);
      yield* service.invalidateModels;
      yield* service.models;
      assert.strictEqual(seen.length, 3);
      const rebooted = yield* make;
      assert.strictEqual((yield* rebooted.current).length, 2);
      assert.strictEqual(seen.length, 3);
    }).pipe(
      Effect.provide(
        layers({ prefix: "openrouter-catalog-", respond: () => Response.json(MODELS), seen }),
      ),
    );
  });
});

describe("OpenRouter catalog failures", () => {
  it.effect("keeps the last good list and waits out the retry window", () => {
    const seen: Seen[] = [];
    let healthy = true;
    return Effect.gen(function* () {
      const service = yield* make;
      assert.strictEqual((yield* service.models).length, 2);
      healthy = false;
      yield* TestClock.adjust("61 minutes");
      assert.strictEqual((yield* service.models).length, 2);
      assert.strictEqual(seen.length, 2);
      // Inside the retry window: no third request.
      yield* service.models;
      assert.strictEqual(seen.length, 2);
      healthy = true;
      yield* service.invalidateModels;
      assert.strictEqual((yield* service.models).length, 2);
      assert.strictEqual(seen.length, 3);
    }).pipe(
      Effect.provide(
        layers({
          prefix: "openrouter-catalog-failure-",
          seen,
          respond: () => (healthy ? Response.json(MODELS) : new Response(null, { status: 503 })),
        }),
      ),
    );
  });
});

describe("OpenRouter configure", () => {
  it.effect("stores the key as a secret and returns redacted settings", () => {
    const seen: Seen[] = [];
    return Effect.gen(function* () {
      const service = yield* make;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const userId = ProviderInstanceId.make("codex_work");
      yield* serverSettings.updateSettings({
        providerInstances: {
          [userId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [{ name: "MY_SECRET", value: "user-secret", sensitive: true }],
          },
        },
      });

      const forClient = yield* service.configure({
        apiKey: "sk-or-test",
        harnesses: { codex: true, claudeAgent: true },
      });
      const codexId = ProviderInstanceId.make("openrouter_codex");
      assert.notInclude(forClient.openRouter.apiKey, "sk-or-test");
      assert.isAbove(forClient.openRouter.apiKey.length, 0);
      assert.deepStrictEqual(forClient.providerInstances[codexId]?.environment, [
        { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
      ]);
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-test");
      assert.notInclude(raw, "user-secret");
      const materialized = yield* serverSettings.getSettings;
      assert.strictEqual(
        materialized.providerInstances[codexId]?.environment?.[0]?.value,
        "sk-or-test",
      );
      assert.strictEqual(
        materialized.providerInstances[userId]?.environment?.[0]?.value,
        "user-secret",
      );
      assert.strictEqual(
        materialized.providerInstances[codexId]?.displayName,
        "OpenRouter (Codex)",
      );
      assert.strictEqual(materialized.providerInstances[codexId]?.enabled, true);
      assert.isUndefined(
        materialized.providerInstances[ProviderInstanceId.make("openrouter_opencode")],
      );

      // rotate
      yield* service.configure({ apiKey: "sk-or-next", harnesses: { codex: false } });
      const rotated = yield* serverSettings.getSettings;
      assert.strictEqual(rotated.providerInstances[codexId]?.environment?.[0]?.value, "sk-or-next");
      assert.strictEqual(rotated.providerInstances[codexId]?.enabled, false);
      assert.strictEqual(rotated.providerInstances[userId]?.environment?.[0]?.value, "user-secret");

      // remove
      yield* service.configure({ apiKey: "" });
      const removed = yield* serverSettings.getSettings;
      assert.strictEqual(removed.openRouter.apiKey, "");
      assert.deepStrictEqual(removed.providerInstances[codexId]?.environment, []);
      assert.strictEqual(
        removed.providerInstances[ProviderInstanceId.make("openrouter_claude")]?.enabled,
        false,
      );
      assert.isTrue(Option.isNone(yield* secrets.get("openrouter-api-key")));
      assert.strictEqual(removed.providerInstances[userId]?.environment?.[0]?.value, "user-secret");
      const after = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(after, "sk-or-next");
    }).pipe(
      Effect.provide(
        layers({ prefix: "openrouter-configure-", respond: () => Response.json(MODELS), seen }),
      ),
    );
  });

  it.effect("tests the key", () => {
    const seen: Seen[] = [];
    let mode: "ok" | "bad" | "down" = "ok";
    return Effect.gen(function* () {
      const service = yield* make;
      assert.deepStrictEqual(yield* service.testConnection({}), {
        status: "error",
        reason: "missing-key",
        message: "Save an OpenRouter API key first.",
      });
      assert.strictEqual(seen.length, 0);
      assert.deepStrictEqual(yield* service.testConnection({ apiKey: "sk-or-draft" }), {
        status: "ok",
        label: "sk-or-v1-abc...123",
        usage: 12.5,
        limit: 100,
        limitRemaining: 87.5,
      });
      assert.strictEqual(seen[0]!.authorization, "Bearer sk-or-draft");
      assert.strictEqual(seen[0]!.url, "https://openrouter.ai/api/v1/key");
      // No draft: the saved key is tested.
      yield* service.configure({ apiKey: "sk-or-saved" });
      yield* service.testConnection({});
      assert.strictEqual(seen.at(-1)!.authorization, "Bearer sk-or-saved");
      mode = "bad";
      const bad = yield* service.testConnection({ apiKey: "sk-or-draft" });
      assert.notInclude(bad.status === "error" ? bad.message : "", "sk-or-draft");
      assert.strictEqual(bad.status === "error" && bad.reason, "invalid-key");
      mode = "down";
      const down = yield* service.testConnection({ apiKey: "sk-or-draft" });
      assert.strictEqual(down.status === "error" && down.reason, "unreachable");
    }).pipe(
      Effect.provide(
        layers({
          prefix: "openrouter-key-",
          seen,
          respond: () =>
            mode === "down"
              ? "network-error"
              : mode === "bad"
                ? Response.json(
                    { error: { message: "User not found.", code: 401 } },
                    { status: 401 },
                  )
                : Response.json({
                    data: {
                      label: "sk-or-v1-abc...123",
                      usage: 12.5,
                      limit: 100,
                      limit_remaining: 87.5,
                    },
                  }),
        }),
      ),
    );
  });
});
