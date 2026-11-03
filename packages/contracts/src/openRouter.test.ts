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
  it("matches a reserved id only together with its own driver", () => {
    for (const entry of OPENROUTER_HARNESSES) {
      expect(isOpenRouterInstance(entry.instanceId, entry.driver)).toBe(true);
    }
    expect(isOpenRouterInstance("openrouter_codex", "claudeAgent")).toBe(false);
    expect(isOpenRouterInstance("codex", "codex")).toBe(false);
    expect(isOpenRouterInstance("claude_openrouter", "claudeAgent")).toBe(false);
  });
});
