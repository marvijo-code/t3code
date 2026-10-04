import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeOpenRouterConnectionTest, readOpenRouterState } from "./OpenRouterSettings.logic";

const settings = (patch: Partial<ServerSettings>): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...patch,
});

describe("readOpenRouterState", () => {
  it("reports a harness on only for an enabled instance of the right driver", () => {
    const state = readOpenRouterState(
      settings({
        openRouter: { apiKey: "marker" },
        providerInstances: {
          [ProviderInstanceId.make("openrouter_codex")]: {
            driver: ProviderDriverKind.make("codex"),
            integration: "openrouter",
            enabled: true,
          },
          [ProviderInstanceId.make("openrouter_claude")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            integration: "openrouter",
            enabled: false,
          },
          [ProviderInstanceId.make("openrouter_opencode")]: {
            driver: ProviderDriverKind.make("cursor"),
            enabled: true,
          },
        },
      }),
    );
    expect(state.keySaved).toBe(true);
    expect(state.harnesses.map((entry) => [entry.label, entry.enabled])).toEqual([
      ["Codex", true],
      ["Claude Code", false],
      ["OpenCode", false],
    ]);
    expect(state.harnesses.map((entry) => entry.reservedIdInUse)).toEqual([false, false, true]);
    expect(readOpenRouterState(DEFAULT_SERVER_SETTINGS).keySaved).toBe(false);
  });

  it("shows a user's own same-driver instance under a reserved id as off and in use", () => {
    const state = readOpenRouterState(
      settings({
        openRouter: { apiKey: "marker" },
        providerInstances: {
          [ProviderInstanceId.make("openrouter_codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
          },
        },
      }),
    );
    expect(state.harnesses[0]).toMatchObject({ enabled: false, reservedIdInUse: true });
  });
});

describe("describeOpenRouterConnectionTest", () => {
  it("states the key label and what credit is left", () => {
    const ok = { status: "ok", label: "sk-or-v1-abc...123", usage: 12.5 } as const;
    expect(describeOpenRouterConnectionTest({ ...ok, limit: 0, limitRemaining: 0 })).toEqual({
      tone: "error",
      text: "No credit remaining on this key.",
    });
    expect(describeOpenRouterConnectionTest({ ...ok, limit: 100, limitRemaining: 87.5 })).toEqual({
      tone: "success",
      text: "Connected as sk-or-v1-abc...123. $87.50 of $100.00 remaining.",
    });
    expect(
      describeOpenRouterConnectionTest({ ...ok, limit: null, limitRemaining: null }).text,
    ).toBe("Connected as sk-or-v1-abc...123. No spending limit on this key. $12.50 used.");
    expect(
      describeOpenRouterConnectionTest({
        status: "ok",
        label: null,
        usage: null,
        limit: null,
        limitRemaining: null,
      }).text,
    ).toBe("Connected. No spending limit on this key.");
  });

  it("passes an error message through", () => {
    expect(
      describeOpenRouterConnectionTest({
        status: "error",
        reason: "invalid-key",
        message: "OpenRouter rejected this key. Check the key and try again.",
      }),
    ).toEqual({
      tone: "error",
      text: "OpenRouter rejected this key. Check the key and try again.",
    });
  });
});
