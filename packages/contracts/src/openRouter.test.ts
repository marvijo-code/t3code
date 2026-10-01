import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { OpenRouterConnectionResult, OPENROUTER_HARNESSES } from "./openRouter.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
import { ProviderInstanceConfig } from "./providerInstance.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const settings = Schema.decodeUnknownSync(ServerSettings);
const patch = Schema.decodeUnknownSync(ServerSettingsPatch);
const result = Schema.decodeUnknownSync(OpenRouterConnectionResult);
const encodeInstance = Schema.encodeSync(ProviderInstanceConfig);
const instance = Schema.decodeUnknownSync(ProviderInstanceConfig);

describe("OpenRouter contracts", () => {
  it("defaults old installations to no key and disabled harnesses", () => {
    expect(settings({}).openRouter).toEqual({
      apiKey: "",
      codex: false,
      claudeCode: false,
      openCode: false,
    });
  });
  it("accepts a narrow patch and retains a saved-key marker", () => {
    expect(patch({ openRouter: { codex: true } })).toEqual({ openRouter: { codex: true } });
    expect(settings({ openRouter: { apiKey: "••••••" } }).openRouter.apiKey).toBe("••••••");
    expect(() => patch({ openRouter: { openCode: "true" } })).toThrow();
  });
  it("validates nullable key limits and rejects malformed results", () => {
    expect(result({ success: true, limitRemaining: null }).limitRemaining).toBeNull();
    expect(result({ success: true, limitRemaining: 2.5 }).limitRemaining).toBe(2.5);
    for (const value of [Infinity, "5", undefined]) {
      expect(() => result({ success: true, limitRemaining: value })).toThrow();
    }
    expect(() => result({ success: false, limitRemaining: null })).toThrow();
  });
  it("round-trips an optional integration without closing the driver namespace", () => {
    expect(instance({ driver: "future_driver", config: { opaque: true } }).driver).toBe(
      "future_driver",
    );
    const owned = instance({ driver: "codex", integration: "openrouter", config: {} });
    expect(encodeInstance(owned).integration).toBe("openrouter");
    expect(() => instance({ driver: "codex", integration: "unknown", config: {} })).toThrow();
  });
  it("registers the exact RPC and stable harness identities", () => {
    expect(WS_METHODS.serverTestOpenRouterConnection).toBe("server.testOpenRouterConnection");
    expect(WsRpcGroup.requests.has(WS_METHODS.serverTestOpenRouterConnection)).toBe(true);
    expect(OPENROUTER_HARNESSES.map((h) => h.instanceId)).toEqual([
      "openrouter_codex",
      "openrouter_claude",
      "openrouter_opencode",
    ]);
  });
});
