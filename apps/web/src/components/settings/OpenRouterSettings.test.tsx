import { Cause } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  config: { apiKey: "", codex: false, claudeCode: false, openCode: false },
  save: vi.fn(),
  test: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
  environments: [] as string[],
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (id: string) => {
    state.environments.push(id);
    return state.config;
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: "save", testOpenRouterConnection: "test" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (kind: string) => (kind === "save" ? state.save : state.test),
}));
import { OpenRouterSettings } from "./OpenRouterSettings";

const environmentId = EnvironmentId.make("remote-test");
const render = (readOnly = false) => {
  hooks.beginRender();
  return OpenRouterSettings({ environmentId, readOnly });
};
const find = (tree: unknown, label: string) => {
  const element = visitElements(
    tree,
    (e) => e.props["aria-label"] === label || e.props.children === label,
  );
  if (!element) throw new Error(`Missing ${label}`);
  return element.props;
};
const action = async (callback: unknown, arg?: unknown) => {
  (callback as (value?: unknown) => void)(arg);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const input = (value: string) =>
  action(find(render(), "OpenRouter API key").onChange, { target: { value } });
const submit = () =>
  action(visitElements(render(), (e) => e.type === "form")!.props.onSubmit, {
    preventDefault() {},
  });
const status = () => visitElements(render(), (e) => e.props.role === "status")!.props.children;

beforeEach(() => {
  hooks.reset();
  state.effects = [];
  state.environments = [];
  state.config = { ...DEFAULT_SERVER_SETTINGS.openRouter };
  state.save.mockReset().mockImplementation(async ({ input: { patch } }) => {
    state.config = { ...state.config, ...patch.openRouter };
    if (patch.openRouter.apiKey === "")
      state.config = { ...state.config, codex: false, claudeCode: false, openCode: false };
    if (patch.openRouter.apiKey) state.config.apiKey = "••••••";
    return { _tag: "Success", value: {} };
  });
  state.test
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { success: true, limitRemaining: 5 } });
});

describe("OpenRouter settings interactions", () => {
  it("saves a typed key to the selected remote environment and clears the draft after acknowledgement", async () => {
    await input("sentinel-ui-key");
    expect(find(render(), "Test connection").disabled).toBe(true);
    await submit();
    expect(state.save).toHaveBeenCalledWith({
      environmentId,
      input: { patch: { openRouter: { apiKey: "sentinel-ui-key" } } },
    });
    expect(find(render(), "OpenRouter API key").value).toBe("");
    expect(state.environments.every((id) => id === environmentId)).toBe(true);
    expect(status()).toBe("OpenRouter settings saved.");
  });
  it("tests only the saved key, clears results on edits and displays safe failures", async () => {
    state.config.apiKey = "••••••";
    await action(find(render(), "Test connection").onClick);
    expect(status()).toContain("Remaining key limit: 5");
    expect(state.test).toHaveBeenCalledWith({ environmentId, input: {} });
    await input("replacement");
    expect(status()).toBe("");
    expect(find(render(), "Test connection").disabled).toBe(true);
    await submit();
    state.test.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("unsafe-sentinel")),
    });
    await action(find(render(), "Test connection").onClick);
    expect(status()).toContain("connection failed");
  });
  it("invalidates saved-key results and late responses on remote updates with identical redaction", async () => {
    state.config = { ...state.config, apiKey: "••••••" };
    await action(find(render(), "Test connection").onClick);
    expect(status()).toContain("Remaining key limit: 5");
    state.config = { ...state.config };
    expect(status()).toBe("");
    let resolve!: (value: unknown) => void;
    state.test.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await action(find(render(), "Test connection").onClick);
    state.config = { ...state.config };
    render();
    resolve({ _tag: "Success", value: { limitRemaining: 99 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(status()).toBe("");
    state.test.mockResolvedValue({ _tag: "Success", value: { limitRemaining: 3 } });
    await action(find(render(), "Test connection").onClick);
    expect(status()).toContain("Remaining key limit: 3");
  });
  it("preserves drafts and switch values when saves fail and uses narrow switch patches", async () => {
    state.config.apiKey = "••••••";
    state.save.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("unsafe-sentinel")),
    });
    await input("unsaved-key");
    await submit();
    expect(find(render(), "OpenRouter API key").value).toBe("unsaved-key");
    await action(find(render(), "Use OpenRouter for Codex").onCheckedChange, true);
    expect(state.save).toHaveBeenLastCalledWith({
      environmentId,
      input: { patch: { openRouter: { codex: true } } },
    });
    expect(find(render(), "Use OpenRouter for Codex").checked).toBe(false);
  });
  it("removes the key, clears the draft and follows server-authoritative disabled switches", async () => {
    state.config = { apiKey: "••••••", codex: true, claudeCode: true, openCode: true };
    await action(find(render(), "Test connection").onClick);
    await action(find(render(), "Remove key").onClick);
    expect(state.save).toHaveBeenLastCalledWith({
      environmentId,
      input: { patch: { openRouter: { apiKey: "" } } },
    });
    for (const label of [
      "Use OpenRouter for Codex",
      "Use OpenRouter for Claude Code",
      "Use OpenRouter for OpenCode",
    ]) {
      expect(find(render(), label).checked).toBe(false);
      expect(find(render(), label).disabled).toBe(true);
    }
  });
  it("disables all operations for read-only/disconnected environments and does not delete an untouched empty draft", async () => {
    state.config.apiKey = "••••••";
    const tree = render(true);
    for (const label of ["Save key", "Test connection", "Remove key", "Use OpenRouter for Codex"])
      expect(find(tree, label).disabled).toBe(true);
    await action(find(tree, "Test connection").onClick);
    expect(state.test).not.toHaveBeenCalled();
    await submit();
    expect(state.save).not.toHaveBeenCalled();
  });
  it("ignores results from an unmounted environment and serializes pending operations", async () => {
    state.config.apiKey = "••••••";
    let resolve!: (value: unknown) => void;
    state.test.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const tree = render();
    const cleanup = state.effects[0]!();
    await action(find(tree, "Test connection").onClick);
    expect(find(render(), "Save key").disabled).toBe(true);
    await action(find(tree, "Use OpenRouter for Codex").onCheckedChange, true);
    expect(state.save).not.toHaveBeenCalled();
    if (cleanup) cleanup();
    resolve({ _tag: "Success", value: { limitRemaining: 99 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(status()).toBe("");
  });
});
