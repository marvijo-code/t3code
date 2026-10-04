import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import {
  applyOpenRouterCatalog,
  ensureOpenRouterCodexLaunchArgs,
  OPENROUTER_CODEX_LAUNCH_ARGS,
  preserveIntegrationMarkers,
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
    openRouter: { apiKey: patch.openRouter?.apiKey ?? current.openRouter.apiKey },
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
      integration: "openrouter",
      displayName: "OpenRouter (Codex)",
      enabled: true,
      environment: [{ name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true }],
      config: { launchArgs: OPENROUTER_CODEX_LAUNCH_ARGS },
    });
    expect(next.providerInstances[claudeId]).toEqual({
      driver: "claudeAgent",
      integration: "openrouter",
      displayName: "OpenRouter (Claude Code)",
      enabled: true,
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-or-test", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        { name: "CLAUDE_CODE_USE_BEDROCK", value: "", sensitive: false },
        { name: "CLAUDE_CODE_USE_VERTEX", value: "", sensitive: false },
        { name: "CLAUDE_CODE_USE_FOUNDRY", value: "", sensitive: false },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: false },
      ],
      config: {},
    });
    expect(next.providerInstances[openCodeId]).toEqual({
      driver: "opencode",
      integration: "openrouter",
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
      launchArgs: `--enable foo ${OPENROUTER_CODEX_LAUNCH_ARGS}`,
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

  // Hostile review finding: a user's own same-driver instance under a reserved
  // id was rewritten with the key and OpenRouter routing on the next key save.
  it("never takes over a user's same-driver instance under a reserved id", () => {
    const mine = {
      driver: ProviderDriverKind.make("codex"),
      displayName: "My direct Codex",
      enabled: true,
      environment: [{ name: "MY_DIRECT_SETTING", value: "unchanged", sensitive: false }],
      config: {},
    };
    const current = settings({ providerInstances: { [codexId]: mine } });
    expect(apply(current, { apiKey: "sk-or-test" }).providerInstances[codexId]).toBe(mine);
    expect(
      apply(current, { apiKey: "sk-or-test", harnesses: { codex: true } }).providerInstances[
        codexId
      ],
    ).toBe(mine);
  });

  it("does not resend an unchanged key", () => {
    const on = apply(settings(), { apiKey: "sk-or-test", harnesses: { codex: true } });
    expect(resolveOpenRouterSettingsPatch(on, { harnesses: { codex: false } }).openRouter).toBe(
      undefined,
    );
  });
});

describe("preserveIntegrationMarkers", () => {
  const managed = {
    driver: ProviderDriverKind.make("codex"),
    integration: "openrouter" as const,
    enabled: true,
  };
  const mine = { driver: ProviderDriverKind.make("codex"), enabled: true };

  it("ignores a marker a client tries to add", () => {
    const current = settings({ providerInstances: { [codexId]: mine } });
    const next = preserveIntegrationMarkers(
      current,
      settings({ providerInstances: { [codexId]: { ...mine, integration: "openrouter" } } }),
    );
    expect(next.providerInstances[codexId]).toEqual(mine);
  });

  it("keeps the marker when a client edits a managed instance without it", () => {
    const current = settings({ providerInstances: { [codexId]: managed } });
    const { integration: _drop, ...edited } = { ...managed, displayName: "Renamed" };
    const next = preserveIntegrationMarkers(
      current,
      settings({ providerInstances: { [codexId]: edited } }),
    );
    expect(next.providerInstances[codexId]).toEqual({ ...edited, integration: "openrouter" });
  });

  it("drops the marker when the driver changes", () => {
    const current = settings({ providerInstances: { [codexId]: managed } });
    const swapped = { ...managed, driver: ProviderDriverKind.make("claudeAgent") };
    const next = preserveIntegrationMarkers(
      current,
      settings({ providerInstances: { [codexId]: swapped } }),
    );
    expect(next.providerInstances[codexId]?.integration).toBeUndefined();
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
  /** The value Codex ends up with for one `-c` key: the last override wins. */
  const effective = (launchArgs: string, key: string) => {
    const args = tokenizeCliArgs(launchArgs);
    let value: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      const config =
        arg === "-c" || arg === "--config"
          ? args[++index]
          : /^(?:-c|--config)=(.*)$/.exec(arg)?.[1];
      if (config?.startsWith(`${key}=`)) value = config.slice(key.length + 1);
    }
    return value;
  };

  it("adds every routing token exactly once and is idempotent", () => {
    expect(ensureOpenRouterCodexLaunchArgs(undefined)).toBe(OPENROUTER_CODEX_LAUNCH_ARGS);
    const once = ensureOpenRouterCodexLaunchArgs("--enable foo");
    expect(once).toBe(`--enable foo ${OPENROUTER_CODEX_LAUNCH_ARGS}`);
    expect(ensureOpenRouterCodexLaunchArgs(once)).toBe(once);
    const withoutFirst = OPENROUTER_CODEX_LAUNCH_ARGS.replace(
      `-c 'model_provider="openrouter"' `,
      "",
    );
    const repaired = ensureOpenRouterCodexLaunchArgs(withoutFirst);
    expect(repaired.match(/model_providers\.openrouter\.name=/g)).toHaveLength(1);
    expect(repaired).toContain(`-c 'model_provider="openrouter"'`);
  });

  // Hostile review finding: T3CODE_CODEX_LAUNCH_ARGS='-c model_provider="openai"'
  // was kept after the routing, so Codex selected openai, not openrouter.
  it("drops conflicting routing overrides in every spelling", () => {
    for (const override of [
      `-c 'model_provider="openai"'`,
      `-c model_provider=openai`,
      `--config 'model_provider="openai"'`,
      `--config=model_provider=openai`,
      `-c='model_provider="openai"'`,
      `-c 'model_providers.openrouter.base_url="https://example.invalid"'`,
    ]) {
      const args = ensureOpenRouterCodexLaunchArgs(`${override} --enable bar`);
      expect(effective(args, "model_provider")).toBe('"openrouter"');
      expect(effective(args, "model_providers.openrouter.base_url")).toBe(
        '"https://openrouter.ai/api/v1"',
      );
      expect(args).not.toContain("example.invalid");
      expect(args).toContain("--enable bar");
    }
  });

  it("keeps unrelated config overrides and their quoting", () => {
    const args = ensureOpenRouterCodexLaunchArgs(
      `-c 'model_reasoning_effort="high"' --strict-config`,
    );
    expect(tokenizeCliArgs(args).slice(0, 3)).toEqual([
      "-c",
      'model_reasoning_effort="high"',
      "--strict-config",
    ]);
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
