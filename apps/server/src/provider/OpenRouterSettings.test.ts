import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import { Schema, Effect } from "effect";
import { ServerSettings } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  materializeOpenRouterInstances,
  reconcileOpenRouterSettings,
} from "./OpenRouterSettings.ts";

const decode = Schema.decodeUnknownSync(ServerSettings);
const initial = () => decode({ openRouter: { apiKey: "sentinel-test-key" } });
const enable = () => {
  const current = initial();
  return reconcileOpenRouterSettings(
    applyServerSettingsPatch(current, {
      openRouter: { codex: true, claudeCode: true, openCode: true },
    }),
    current,
  );
};

describe("OpenRouter settings reconciliation", () => {
  it("creates exactly the three canonical instances and is idempotent", () => {
    const next = enable();
    expect(Object.keys(next.providerInstances)).toEqual([
      "openrouter_codex",
      "openrouter_claude",
      "openrouter_opencode",
    ]);
    expect(next.providerInstances.openrouter_codex).toMatchObject({
      driver: "codex",
      integration: "openrouter",
      enabled: true,
      displayName: "OpenRouter (Codex)",
      config: { setupMode: "existing" },
    });
    expect(next.providerInstances.openrouter_opencode?.config).toMatchObject({ serverUrl: "" });
    expect(reconcileOpenRouterSettings(next)).toEqual(next);
    expect(next.providers).toEqual(initial().providers);
  });
  it("keeps stable disabled identities on off, re-enable and remove", () => {
    const current = enable();
    const off = reconcileOpenRouterSettings(
      applyServerSettingsPatch(current, { openRouter: { codex: false } }),
      current,
    );
    expect(off.providerInstances.openrouter_codex?.enabled).toBe(false);
    const on = reconcileOpenRouterSettings(
      applyServerSettingsPatch(off, { openRouter: { codex: true } }),
      off,
    );
    expect(on.providerInstances.openrouter_codex).toEqual(
      current.providerInstances.openrouter_codex,
    );
    const removed = reconcileOpenRouterSettings(
      applyServerSettingsPatch(on, { openRouter: { apiKey: "" } }),
      on,
    );
    expect(removed.openRouter).toEqual({
      apiKey: "",
      codex: false,
      claudeCode: false,
      openCode: false,
    });
    expect(Object.values(removed.providerInstances).every((entry) => entry.enabled === false)).toBe(
      true,
    );
    const saved = reconcileOpenRouterSettings(
      applyServerSettingsPatch(removed, { openRouter: { apiKey: "replacement" } }),
      removed,
    );
    expect(saved.openRouter.codex).toBe(false);
  });
  it("rejects missing keys and occupied IDs without changing the input", () => {
    const empty = decode({});
    expect(() =>
      reconcileOpenRouterSettings(
        applyServerSettingsPatch(empty, { openRouter: { codex: true } }),
        empty,
      ),
    ).toThrow(/Save an OpenRouter/);
    const occupied = decode({
      openRouter: { apiKey: "test" },
      providerInstances: {
        openrouter_codex: { driver: "codex", displayName: "My Codex", config: {} },
      },
    });
    const before = JSON.stringify(occupied);
    expect(() =>
      reconcileOpenRouterSettings(
        applyServerSettingsPatch(occupied, { openRouter: { codex: true } }),
        occupied,
      ),
    ).toThrow(/already in use/);
    expect(JSON.stringify(occupied)).toBe(before);
  });
  it("restores owned instances omitted or modified by stale map replacement", () => {
    const current = enable();
    const restored = reconcileOpenRouterSettings(
      applyServerSettingsPatch(current, { providerInstances: {} }),
      current,
    );
    expect(restored.providerInstances).toEqual(current.providerInstances);
    const edited = applyServerSettingsPatch(current, {
      providerInstances: {
        ...current.providerInstances,
        openrouter_codex: {
          driver: "codex",
          enabled: false,
          displayName: "Wrong",
          environment: [{ name: "OPENROUTER_API_KEY", value: "bad" }],
          config: { binaryPath: "/test/codex", homePath: "/wrong", setupMode: "managed" },
        },
      },
    });
    const normalized = reconcileOpenRouterSettings(edited, current).providerInstances
      .openrouter_codex;
    expect(normalized).toMatchObject({
      enabled: true,
      displayName: "OpenRouter (Codex)",
      config: { binaryPath: "/test/codex", setupMode: "existing" },
    });
    expect(normalized?.environment).toBeUndefined();
    expect(normalized?.config).not.toHaveProperty("homePath");
  });
  it("preserves unrelated and same-name instances and rejects forged ownership", () => {
    const current = applyServerSettingsPatch(initial(), {
      providerInstances: {
        custom: {
          driver: "codex",
          displayName: "OpenRouter (Codex)",
          config: { binaryPath: "custom-codex" },
        },
      },
    });
    const next = reconcileOpenRouterSettings(
      applyServerSettingsPatch(current, { openRouter: { codex: true } }),
      current,
    );
    expect(next.providerInstances.custom).toEqual(current.providerInstances.custom);
    const forged = applyServerSettingsPatch(initial(), {
      providerInstances: {
        openrouter_codex: { driver: "codex", integration: "openrouter", config: {} },
      },
    });
    expect(
      reconcileOpenRouterSettings(forged, initial()).providerInstances.openrouter_codex,
    ).toBeUndefined();
    const foreign = decode({
      providerInstances: {
        openrouter_codex: { driver: "future-driver", integration: "openrouter", config: {} },
      },
    });
    expect(reconcileOpenRouterSettings(foreign)).toEqual(foreign);
    expect(reconcileOpenRouterSettings(forged, foreign).providerInstances.openrouter_codex).toEqual(
      foreign.providerInstances.openrouter_codex,
    );
    const unmarked = decode({
      providerInstances: {
        openrouter_codex: { driver: "codex", displayName: "Personal", config: {} },
      },
    });
    expect(
      reconcileOpenRouterSettings(forged, unmarked).providerInstances.openrouter_codex,
    ).toEqual(unmarked.providerInstances.openrouter_codex);
  });
  it("injects credentials only at runtime, with explicit blanks and nonsecret OpenCode config", () => {
    const current = enable();
    const runtime = materializeOpenRouterInstances(current, [
      { slug: "vendor/raw/model", name: "Test", isCustom: false, capabilities: null },
    ]);
    expect(JSON.stringify(current.providerInstances)).not.toContain("sentinel-test-key");
    expect(runtime.openrouter_codex?.environment).toContainEqual({
      name: "OPENROUTER_API_KEY",
      value: "sentinel-test-key",
      sensitive: true,
    });
    expect(runtime.openrouter_claude?.environment).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      value: "",
      sensitive: true,
    });
    const content = runtime.openrouter_opencode?.environment?.find(
      (v) => v.name === "OPENCODE_CONFIG_CONTENT",
    )?.value;
    expect(content).not.toContain("sentinel-test-key");
    expect(JSON.parse(content!)).toMatchObject({
      provider: {
        openrouter: {
          options: { apiKey: "{env:OPENROUTER_API_KEY}" },
          models: { "vendor/raw/model": { name: "Test" } },
        },
      },
    });
    const missing = materializeOpenRouterInstances(
      { ...current, openRouter: { ...current.openRouter, apiKey: "••••••" } },
      [],
    );
    expect(Object.values(missing).every((v) => v.enabled === false)).toBe(true);
    expect(missing.openrouter_codex?.environment?.[0]?.value).toBe("");
  });
  effectIt.effect("serializes concurrent narrow switch patches", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      yield* Effect.all(
        [
          service.updateSettings({ openRouter: { codex: true } }),
          service.updateSettings({ openRouter: { claudeCode: true } }),
        ],
        { concurrency: 2 },
      );
      const value = yield* service.getSettings;
      expect(value.openRouter).toMatchObject({ codex: true, claudeCode: true });
    }).pipe(Effect.provide(ServerSettingsService.layerTest({ openRouter: { apiKey: "test" } }))),
  );
});
