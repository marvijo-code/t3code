import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { CodexSettings } from "@t3tools/contracts";
import { Effect, FileSystem, Schema } from "effect";
import { CodexDriver } from "./CodexDriver.ts";
import { OpenRouterDriverTestLayer, runtimeEntry } from "./OpenRouterDriver.testFixtures.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { ServerConfig } from "../../config.ts";

const probe = vi.hoisted(() => vi.fn());
vi.mock("../Layers/CodexProvider.ts", async (original) => ({
  ...(await original<typeof import("../Layers/CodexProvider.ts")>()),
  probeCodexSkillsForCwd: probe,
}));
const decode = Schema.decodeUnknownSync(CodexSettings);

it.layer(OpenRouterDriverTestLayer)("OpenRouter workspace discovery", (it) => {
  it.effect("uses the managed Codex home and launch environment for workspace skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const directory = yield* fs.makeTempDirectoryScoped();
      const binaryPath = writeFakeCli({
        directory,
        name: "codex",
        source: 'console.log("codex-cli 0.139.0");',
      });
      const skill = { name: "workspace-skill", path: `${directory}/SKILL.md`, enabled: true };
      probe.mockReturnValue(Effect.succeed([skill]));
      const entry = runtimeEntry("codex", binaryPath);
      const instance = yield* CodexDriver.create({
        ...entry,
        enabled: true,
        environment: entry.environment ?? [],
        config: decode(entry.config),
      });
      expect((yield* instance.snapshotForCwd!(directory)).skills).toEqual([skill]);
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          binaryPath,
          cwd: directory,
          homePath: `${config.stateDir}/provider-homes/${entry.instanceId}`,
          launchArgs: expect.stringContaining('model_provider="openrouter"'),
          environment: expect.objectContaining({
            OPENROUTER_API_KEY: "driver-sentinel-key",
            CODEX_HOME: `${config.stateDir}/provider-homes/${entry.instanceId}`,
          }),
        }),
      );
    }),
  );
});
