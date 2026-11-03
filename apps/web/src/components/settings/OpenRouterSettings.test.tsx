// @vitest-environment jsdom
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OpenRouterConnectionTestResult,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: null as unknown,
  config: null as unknown,
}));
const mocks = vi.hoisted(() => ({ configure: vi.fn(), test: vi.fn() }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.config }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    configureOpenRouter: "configure",
    testOpenRouterConnection: "test",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "configure" ? mocks.configure : mocks.test),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => state.settings,
  usePrimarySettingsAvailable: () => true,
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "",
}));
vi.mock("./SettingsScopeContext", () => ({ useOptionalSettingsScope: () => null }));
vi.mock("./useScopedSettings", () => ({
  useClearScopedSettings: () => () => undefined,
  useClearProjectOverrides: () => () => undefined,
}));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));

import { OpenRouterSettings } from "./OpenRouterSettings";

const environmentId = EnvironmentId.make("environment-1");
const SAVED_MARKER = "saved-key-marker";

let root: Root;
let container: HTMLDivElement;

const settingsWith = (patch: Partial<UnifiedSettings>): UnifiedSettings => ({
  ...DEFAULT_UNIFIED_SETTINGS,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.config = { environment: { capabilities: { openRouter: true } } };
  mocks.configure.mockResolvedValue({ _tag: "Success", value: DEFAULT_UNIFIED_SETTINGS });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(readOnly = false) {
  await act(async () => {
    root.render(<OpenRouterSettings environmentId={environmentId} readOnly={readOnly} />);
  });
}

function keyInput(): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find(
    (element) => element.textContent === "OpenRouter API key",
  );
  expect(label, "label OpenRouter API key").toBeDefined();
  return document.getElementById(label!.htmlFor) as HTMLInputElement;
}

function button(name: string): HTMLButtonElement {
  const element = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  expect(element, `button ${name}`).toBeDefined();
  return element!;
}

function harnessSwitch(harness: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[role="switch"][aria-label="Use OpenRouter for ${harness}"]`,
  );
  expect(element, `switch ${harness}`).not.toBeNull();
  return element!;
}

async function type(value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(keyInput(), value);
    keyInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("OpenRouterSettings", () => {
  it("names the section and its controls", async () => {
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("OpenRouter");
    expect(keyInput().type).toBe("password");
    button("Save key");
    button("Test connection");
    for (const harness of ["Codex", "Claude Code", "OpenCode"]) {
      expect(harnessSwitch(harness).getAttribute("aria-checked")).toBe("false");
    }
  });

  it("saves a typed key and clears the field", async () => {
    await render();
    await type("sk-or-test");
    await click(button("Save key"));
    expect(mocks.configure).toHaveBeenCalledWith({
      environmentId,
      input: { apiKey: "sk-or-test" },
    });
    expect(keyInput().value).toBe("");
  });

  it("shows a saved key as set without its value and can remove it", async () => {
    state.settings = settingsWith({ openRouter: { apiKey: SAVED_MARKER } });
    await render();
    expect(keyInput().value).toBe("");
    expect(container.textContent).toContain("A key is saved.");
    expect(container.innerHTML).not.toContain(SAVED_MARKER);
    await click(button("Remove key"));
    expect(mocks.configure).toHaveBeenCalledWith({ environmentId, input: { apiKey: "" } });
  });

  it("switches a harness once a key is saved", async () => {
    await render();
    expect(harnessSwitch("Codex").hasAttribute("data-disabled")).toBe(true);

    state.settings = settingsWith({
      openRouter: { apiKey: SAVED_MARKER },
      providerInstances: {
        [ProviderInstanceId.make("openrouter_claude")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
        },
      },
    });
    await render();
    expect(harnessSwitch("Claude Code").getAttribute("aria-checked")).toBe("true");
    expect(harnessSwitch("Codex").getAttribute("aria-checked")).toBe("false");
    await click(harnessSwitch("Codex"));
    expect(mocks.configure).toHaveBeenCalledWith({
      environmentId,
      input: { harnesses: { codex: true } },
    });
  });

  it("tests the typed key, then reports what OpenRouter said", async () => {
    const ok: OpenRouterConnectionTestResult = {
      status: "ok",
      label: "sk-or-v1-abc...123",
      usage: 12.5,
      limit: 100,
      limitRemaining: 87.5,
    };
    mocks.test.mockResolvedValueOnce({ _tag: "Success", value: ok });
    await render();
    await type("sk-or-draft");
    await click(button("Test connection"));
    expect(mocks.test).toHaveBeenCalledWith({ environmentId, input: { apiKey: "sk-or-draft" } });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Connected as sk-or-v1-abc...123. $87.50 of $100.00 remaining.",
    );

    mocks.test.mockResolvedValueOnce({
      _tag: "Success",
      value: { status: "error", reason: "invalid-key", message: "OpenRouter rejected this key." },
    });
    await click(button("Test connection"));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "OpenRouter rejected this key.",
    );
  });

  it("is inert for a read-only session and absent on a server without OpenRouter", async () => {
    state.settings = settingsWith({ openRouter: { apiKey: SAVED_MARKER } });
    await render(true);
    expect(keyInput().matches(":disabled")).toBe(true);
    expect(button("Test connection").matches(":disabled")).toBe(true);
    expect(harnessSwitch("OpenCode").hasAttribute("data-disabled")).toBe(true);

    state.config = { environment: { capabilities: {} } };
    await render();
    expect(container.textContent).toBe("");
  });
});
