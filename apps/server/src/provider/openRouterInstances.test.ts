import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyOpenRouterCatalog,
  ensureOpenRouterCodexLaunchArgs,
  OPENROUTER_CODEX_LAUNCH_ARGS,
  resolveOpenRouterSettingsPatch,
} from "./openRouterInstances.ts";

const codexId = ProviderInstanceId.make("openrouter_codex");
const claudeId = ProviderInstanceId.make("openrouter_claude");
const openCodeId = ProviderInstanceId.make("openrouter_opencode");
const userId = ProviderInstanceId.make("codex_work");

const settings = (patch: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...patch,
});
const apply = (
  current: ServerSettings,
  input: Parameters<typeof resolveOpenRouterSettingsPatch>[1],
) => {
  const patch = resolveOpenRouterSettingsPatch(current, input);
  return settings({
    ...current,
    openRouter: { apiKey: patch.openRouter?.apiKey ?? "" },
    providerInstances: patch.providerInstances as ServerSettings["providerInstances"],
  });
};

describe("resolveOpenRouterSettingsPatch", () => {
  it("creates each harness instance from the key", () => {
    const next = apply(settings(), {
      apiKey: "sk-or-test",
      harnesses: { codex: true, claudeAgent: true, opencode: true },
    });
    expect(next.providerInstances[codexId]).toEqual({
      driver: "codex",
      displayName: "OpenRouter (Codex)",
      enabled: true,
      environment: [{ name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true }],
      config: { launchArgs: OPENROUTER_CODEX_LAUNCH_ARGS },
    });
    expect(next.providerInstances[claudeId]).toEqual({
      driver: "claudeAgent",
      displayName: "OpenRouter (Claude Code)",
      enabled: true,
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-or-test", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ],
      config: {},
    });
    expect(next.providerInstances[openCodeId]).toEqual({
      driver: "opencode",
      displayName: "OpenRouter (OpenCode)",
      enabled: true,
      environment: [{ name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true }],
      config: {},
    });
  });

  it("keeps user edits, never touches other instances, and is idempotent", () => {
    const user = {
      driver: ProviderDriverKind.make("codex"),
      environment: [{ name: "MINE", value: "x", sensitive: true, valueRedacted: true }],
    };
    const first = apply(settings({ providerInstances: { [userId]: user } }), {
      apiKey: "sk-or-test",
      harnesses: { codex: true },
    });
    expect(first.providerInstances[userId]).toBe(user);
    const edited = settings({
      ...first,
      providerInstances: {
        ...first.providerInstances,
        [codexId]: {
          ...first.providerInstances[codexId]!,
          displayName: "My router",
          accentColor: "#ff0000",
          environment: [
            ...first.providerInstances[codexId]!.environment!,
            { name: "EXTRA", value: "1", sensitive: false },
          ],
          config: { launchArgs: "--enable foo", customModels: ["vendor/custom"] },
        },
      },
    });
    const rotated = apply(edited, { apiKey: "sk-or-next" });
    const codex = rotated.providerInstances[codexId]!;
    expect(codex.displayName).toBe("My router");
    expect(codex.accentColor).toBe("#ff0000");
    expect(codex.environment).toEqual([
      { name: "EXTRA", value: "1", sensitive: false },
      { name: "OPENROUTER_API_KEY", value: "sk-or-next", sensitive: true },
    ]);
    expect(codex.config).toEqual({
      launchArgs: `${OPENROUTER_CODEX_LAUNCH_ARGS} --enable foo`,
      customModels: ["vendor/custom"],
    });
    expect(apply(rotated, { harnesses: { codex: true } }).providerInstances[codexId]).toEqual(
      codex,
    );
  });

  it("turns everything off without a key and creates nothing", () => {
    expect(apply(settings(), { harnesses: { codex: true } }).providerInstances).toEqual({});
    const on = apply(settings(), {
      apiKey: "sk-or-test",
      harnesses: { codex: true, claudeAgent: true },
    });
    const off = apply(on, { harnesses: { codex: false } });
    expect(off.providerInstances[codexId]?.enabled).toBe(false);
    expect(off.providerInstances[codexId]?.environment?.[0]?.value).toBe("sk-or-test");
    const removed = apply(on, { apiKey: "" });
    expect(removed.providerInstances[codexId]?.enabled).toBe(false);
    expect(removed.providerInstances[codexId]?.environment).toEqual([]);
    expect(removed.providerInstances[claudeId]?.enabled).toBe(false);
    expect(removed.providerInstances[claudeId]?.environment?.some((entry) => entry.sensitive)).toBe(
      false,
    );
    expect(removed.providerInstances[openCodeId]).toBeUndefined();
  });

  it("leaves a reserved id that belongs to another driver alone", () => {
    const foreign = { driver: ProviderDriverKind.make("cursor") };
    const next = apply(settings({ providerInstances: { [codexId]: foreign } }), {
      apiKey: "sk-or-test",
      harnesses: { codex: true },
    });
    expect(next.providerInstances[codexId]).toBe(foreign);
  });
});

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "built-in",
  name: "Built In",
  isCustom: false,
  capabilities: null,
  ...overrides,
});
type Draft = Pick<
  ServerProvider,
  "models" | "auth" | "enabled" | "checkedAt" | "usageLimits" | "message"
>;
const draft = (models: ReadonlyArray<ServerProviderModel>, enabled = true): Draft => ({
  models,
  enabled,
  checkedAt: "2026-09-30T00:00:00.000Z",
  auth: { status: "authenticated", type: "apiKey", label: "Claude API Key" },
});
const CATALOG = [
  { id: "openai/b:batch", name: "OpenAI: B (batch)" },
  { id: "openai/b", name: "OpenAI: B" },
  { id: "anthropic/a", name: "Anthropic: A" },
  { id: "router/auto", name: "Auto Router" },
];

describe("ensureOpenRouterCodexLaunchArgs", () => {
  it("adds only the routing tokens that are missing", () => {
    expect(ensureOpenRouterCodexLaunchArgs(undefined)).toBe(OPENROUTER_CODEX_LAUNCH_ARGS);
    expect(ensureOpenRouterCodexLaunchArgs(`${OPENROUTER_CODEX_LAUNCH_ARGS} --enable foo`)).toBe(
      `${OPENROUTER_CODEX_LAUNCH_ARGS} --enable foo`,
    );
    const withoutFirst = OPENROUTER_CODEX_LAUNCH_ARGS.replace(
      `-c 'model_provider="openrouter"' `,
      "",
    );
    const repaired = ensureOpenRouterCodexLaunchArgs(withoutFirst);
    expect(repaired.match(/model_providers\.openrouter\.name=/g)).toHaveLength(1);
    expect(repaired).toContain(`-c 'model_provider="openrouter"'`);
  });

  it("puts the routing in front of an operator override", () => {
    expect(ensureOpenRouterCodexLaunchArgs("--enable bar")).toBe(
      `${OPENROUTER_CODEX_LAUNCH_ARGS} --enable bar`,
    );
  });
});

describe("applyOpenRouterCatalog", () => {
  it("replaces built-in models, keeps custom ones, and marks the vendor default", () => {
    const shaped = applyOpenRouterCatalog(
      ProviderDriverKind.make("codex"),
      draft([
        model({}),
        model({ slug: "mine", isCustom: true }),
        model({ slug: "openai/b", isCustom: true }),
      ]),
      CATALOG,
    );
    expect(shaped.models.map((entry) => entry.slug)).toEqual([
      "openai/b:batch",
      "openai/b",
      "anthropic/a",
      "router/auto",
      "mine",
    ]);
    expect(shaped.models.filter((entry) => entry.isDefault).map((entry) => entry.slug)).toEqual([
      "openai/b",
    ]);
    expect(shaped.models[2]).toEqual({
      slug: "anthropic/a",
      name: "Anthropic: A",
      subProvider: "Anthropic",
      isCustom: false,
      capabilities: null,
    });
    expect(shaped.models[3]?.subProvider).toBeUndefined();
    expect(shaped.auth).toEqual({
      status: "authenticated",
      type: "openrouter",
      label: "OpenRouter",
    });
    expect(shaped.usageLimits?.unavailable?.reason).toBe("unsupported");
  });

  it("lists for OpenCode only what OpenCode reported, with its selectors", () => {
    const capabilities = { optionDescriptors: [] };
    const openCode = ProviderDriverKind.make("opencode");
    const native = [
      model({ slug: "openrouter/anthropic/a", capabilities }),
      model({ slug: "openrouter/retired/x" }),
      model({ slug: "anthropic/direct" }),
    ];
    expect(applyOpenRouterCatalog(openCode, draft(native), CATALOG).models).toEqual([
      {
        slug: "openrouter/anthropic/a",
        name: "Anthropic: A",
        subProvider: "Anthropic",
        isCustom: false,
        capabilities,
      },
    ]);
    expect(applyOpenRouterCatalog(openCode, draft([]), CATALOG).models).toHaveLength(4);
    expect(
      applyOpenRouterCatalog(openCode, draft(native), []).models.map((entry) => entry.slug),
    ).toEqual(["openrouter/anthropic/a", "openrouter/retired/x"]);
  });

  it("says so when an enabled instance has no catalog", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    expect(applyOpenRouterCatalog(claude, draft([model({})]), []).message).toMatch(
      /OpenRouter model list/,
    );
    const disabled = applyOpenRouterCatalog(claude, draft([model({})], false), []);
    expect(disabled.message).toBeUndefined();
    expect(disabled.usageLimits).toBeUndefined();
    const untouched = draft([model({})], false);
    expect(applyOpenRouterCatalog(claude, untouched, [])).toBe(untouched);
  });
});
