import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { isOpenRouterInstance, OPENROUTER_HARNESSES } from "./openRouter.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("OpenRouter settings", () => {
  it("defaults to no key and trims a patched key", () => {
    expect(decodeServerSettings({}).openRouter).toEqual({ apiKey: "" });
    expect(
      decodeServerSettingsPatch({ openRouter: { apiKey: "  sk-or-test  " } }).openRouter,
    ).toEqual({ apiKey: "sk-or-test" });
  });
});

describe("isOpenRouterInstance", () => {
  const managed = (driver: string) => ({ driver, integration: "openrouter" });

  it("matches a reserved id only together with its own driver and the marker", () => {
    for (const entry of OPENROUTER_HARNESSES) {
      expect(isOpenRouterInstance(entry.instanceId, managed(entry.driver))).toBe(true);
    }
    expect(isOpenRouterInstance("openrouter_codex", managed("claudeAgent"))).toBe(false);
    expect(isOpenRouterInstance("codex", managed("codex"))).toBe(false);
    expect(isOpenRouterInstance("claude_openrouter", managed("claudeAgent"))).toBe(false);
    expect(isOpenRouterInstance("openrouter_codex", undefined)).toBe(false);
  });

  it("does not claim a user's own instance under a reserved id", () => {
    expect(isOpenRouterInstance("openrouter_codex", { driver: "codex" })).toBe(false);
  });

  it("round-trips the marker through settings", () => {
    const settings = decodeServerSettings({
      providerInstances: { openrouter_codex: managed("codex") },
    });
    expect(settings.providerInstances[OPENROUTER_HARNESSES[0].instanceId]?.integration).toBe(
      "openrouter",
    );
  });
});
