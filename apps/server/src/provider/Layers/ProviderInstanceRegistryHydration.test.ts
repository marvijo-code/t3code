import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Queue, Schema, Scope, Stream } from "effect";
import {
  ServerSettings,
  type ProviderInstanceConfigMap,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { reconcileOpenRouterSettings } from "../OpenRouterSettings.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenRouterCatalog } from "../OpenRouterCatalog.ts";
import {
  deriveProviderInstanceConfigMap,
  prepareProviderInstanceHydration,
} from "./ProviderInstanceRegistryHydration.ts";
const decode = Schema.decodeUnknownSync(ServerSettings);

describe("OpenRouter registry hydration", () => {
  it("injects only owned runtime envelopes and rebuilds OpenCode definitions only when model content changes", () => {
    const initial = decode({
      openRouter: { apiKey: "hydration-secret" },
      providerInstances: {
        custom: { driver: "codex", displayName: "OpenRouter (Codex)", config: {} },
      },
    });
    const settings = reconcileOpenRouterSettings(
      {
        ...initial,
        openRouter: { ...initial.openRouter, codex: true, claudeCode: true, openCode: true },
      },
      initial,
    );
    const models = [{ slug: "vendor/model", name: "Test", isCustom: false, capabilities: null }];
    const first = deriveProviderInstanceConfigMap(settings, models);
    expect(first.custom).toEqual(settings.providerInstances.custom);
    expect(first.codex?.environment).toBeUndefined();
    expect(
      first.openrouter_claude?.environment?.find((v) => v.name === "ANTHROPIC_AUTH_TOKEN"),
    ).toMatchObject({ value: "hydration-secret", sensitive: true });
    expect(deriveProviderInstanceConfigMap(settings, [...models])).toEqual(first);
    const updated = deriveProviderInstanceConfigMap(settings, [
      ...models,
      { ...models[0]!, slug: "vendor/new" },
    ]);
    expect(updated.openrouter_opencode).not.toEqual(first.openrouter_opencode);
    expect(updated.openrouter_codex).toEqual(first.openrouter_codex);
    expect(updated.openrouter_claude).toEqual(first.openrouter_claude);
    expect(JSON.stringify(settings.providerInstances)).not.toContain("hydration-secret");
  });
});

it.effect(
  "OpenRouter live hydration watches settings and catalog streams until scope closure",
  () =>
    Effect.gen(function* () {
      const settingsEvents = yield* Queue.unbounded<ServerSettings>();
      const catalogEvents = yield* Queue.unbounded<ReadonlyArray<ServerProviderModel>>();
      const reconciled = yield* Queue.unbounded<ProviderInstanceConfigMap>();
      const closed = yield* Deferred.make<void>();
      let settings = decode({
        openRouter: { apiKey: "initial-stream-key" },
        providerInstances: {
          custom: { driver: "codex", config: { binaryPath: "personal-codex" } },
        },
      });
      settings = reconcileOpenRouterSettings(
        {
          ...settings,
          openRouter: { ...settings.openRouter, codex: true, claudeCode: true, openCode: true },
        },
        settings,
      );
      let models: ReadonlyArray<ServerProviderModel> = [
        { slug: "vendor/first", name: "First", isCustom: false, capabilities: null },
      ];
      let refreshed = false;
      const services = Layer.merge(
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.sync(() => settings),
          subscribeChanges: Effect.succeed(Stream.fromQueue(settingsEvents)),
        }),
        Layer.succeed(OpenRouterCatalog, {
          current: Effect.sync(() => models),
          refresh: Effect.sync(() => {
            refreshed = true;
            return models;
          }),
          forceRefresh: Effect.sync(() => models),
          subscribeChanges: Effect.succeed(
            Stream.fromQueue(catalogEvents).pipe(
              Stream.ensuring(Deferred.succeed(closed, undefined)),
            ),
          ),
        }),
      );
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const hydration = yield* prepareProviderInstanceHydration().pipe(
        Effect.provide(services),
        Effect.provideService(Scope.Scope, scope),
      );
      expect(refreshed).toBe(true);
      const original = hydration.initialConfigMap;
      expect(original.openrouter_codex?.environment?.[0]?.value).toBe("initial-stream-key");
      const watcher = yield* hydration
        .watch({ reconcile: (map) => Queue.offer(reconciled, map).pipe(Effect.asVoid) })
        .pipe(Effect.provideService(Scope.Scope, scope));
      const assertNormal = (map: ProviderInstanceConfigMap) => {
        expect(map.custom).toEqual(original.custom);
        expect(map.codex).toEqual(original.codex);
        expect(map.claudeAgent).toEqual(original.claudeAgent);
        expect(map.opencode).toEqual(original.opencode);
      };
      settings = {
        ...settings,
        openRouter: { ...settings.openRouter, apiKey: "rotated-stream-key" },
      };
      yield* Queue.offer(settingsEvents, settings);
      const rotated = yield* Queue.take(reconciled);
      expect(rotated.openrouter_codex?.environment?.[0]?.value).toBe("rotated-stream-key");
      assertNormal(rotated);
      models = [...models, { ...models[0]!, slug: "vendor/second" }];
      yield* Queue.offer(catalogEvents, models);
      const catalogUpdate = yield* Queue.take(reconciled);
      expect(catalogUpdate.openrouter_opencode).not.toEqual(rotated.openrouter_opencode);
      expect(catalogUpdate.openrouter_codex).toEqual(rotated.openrouter_codex);
      assertNormal(catalogUpdate);
      models = [...models];
      yield* Queue.offer(catalogEvents, models);
      expect(yield* Queue.take(reconciled)).toEqual(catalogUpdate);
      settings = reconcileOpenRouterSettings(
        { ...settings, openRouter: { ...settings.openRouter, codex: false } },
        settings,
      );
      yield* Queue.offer(settingsEvents, settings);
      const disabled = yield* Queue.take(reconciled);
      expect(disabled.openrouter_codex?.enabled).toBe(false);
      assertNormal(disabled);
      settings = reconcileOpenRouterSettings(
        { ...settings, openRouter: { ...settings.openRouter, apiKey: "" } },
        settings,
      );
      yield* Queue.offer(settingsEvents, settings);
      const removed = yield* Queue.take(reconciled);
      for (const id of ["openrouter_codex", "openrouter_claude", "openrouter_opencode"])
        expect(removed[id]?.enabled).toBe(false);
      expect(removed.openrouter_codex?.environment?.[0]?.value).toBe("");
      assertNormal(removed);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(closed);
      expect(watcher.pollUnsafe()).toBeDefined();
    }),
);
