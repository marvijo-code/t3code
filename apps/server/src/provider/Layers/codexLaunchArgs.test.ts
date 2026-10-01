import { OPENROUTER_CODEX_ARGS } from "../OpenRouterProvider.ts";
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

it("OpenRouter TOML quoting survives app-server and exec tokenization", () => {
  const expected = [
    'model_provider="openrouter"',
    'model_providers.openrouter.name="OpenRouter"',
    'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
    'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
    'model_providers.openrouter.wire_api="responses"',
    "model_providers.openrouter.requires_openai_auth=false",
    "model_providers.openrouter.supports_websockets=false",
  ].flatMap((value) => ["-c", value]);
  NodeAssert.deepEqual(codexAppServerArgs(OPENROUTER_CODEX_ARGS), ["app-server", ...expected]);
  NodeAssert.deepEqual(codexExecLaunchArgs(OPENROUTER_CODEX_ARGS), expected);
});
