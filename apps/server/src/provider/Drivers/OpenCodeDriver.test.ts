import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { OpenCodeSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { OpenCodeDriver } from "./OpenCodeDriver.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import {
  OpenRouterDriverTestLayer,
  runtimeEntry,
  modelSlug,
} from "./OpenRouterDriver.testFixtures.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
const decode = Schema.decodeUnknownSync(OpenCodeSettings);

it.layer(OpenRouterDriverTestLayer)("OpenRouter OpenCodeDriver", (it) => {
  it.effect(
    "sends settings key-reference config to the local server and raw model IDs to the SDK",
    () => {
      let capturedEnvironment: NodeJS.ProcessEnv | undefined;
      let selected: unknown;
      const runtime = Layer.mock(OpenCodeRuntime)({
        startOpenCodeServerProcess: (input) =>
          Effect.sync(() => {
            capturedEnvironment = input.environment;
            return {
              url: "http://127.0.0.1:4301",
              version: "1.14.19",
              isRunning: Effect.succeed(true),
              exitCode: Effect.never,
            };
          }),
        loadOpenCodeSkills: () =>
          Effect.succeed([{ name: "workspace-skill", location: "/synthetic/SKILL.md" }]),
        createOpenCodeSdkClient: () =>
          ({
            command: { list: async () => ({ data: [{ name: "workspace-command", hints: [] }] }) },
            session: {
              create: async () => ({ data: { id: "session-test" } }),
              prompt: async (input: unknown) => {
                selected = input;
                return {
                  data: { parts: [{ type: "text", text: '{"title":"OpenRouter title"}' }] },
                };
              },
              delete: async () => ({}),
            },
          }) as unknown as OpencodeClient,
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const binaryPath = writeFakeCli({
          directory,
          name: "opencode",
          source: 'console.log("1.14.19");',
        });
        const entry = runtimeEntry("opencode", binaryPath);
        const instance = yield* OpenCodeDriver.create({
          ...entry,
          enabled: true,
          displayName: entry.displayName,
          environment: entry.environment ?? [],
          config: decode({
            ...(entry.config as object),
            serverUrl: "https://must-not-connect.invalid",
          }),
        });
        const workspace = yield* instance.snapshotForCwd!(directory);
        expect(workspace.supportsConversationRollback).not.toBe(false);
        expect(workspace.showInteractionModeToggle).toBe(false);
        expect(workspace.skills).toEqual([expect.objectContaining({ name: "workspace-skill" })]);
        expect(workspace.slashCommands).toContainEqual(
          expect.objectContaining({ name: "workspace-command" }),
        );
        const result = yield* instance.textGeneration.generateThreadTitle({
          cwd: directory,
          message: "Test",
          modelSelection: createModelSelection(entry.instanceId, modelSlug),
        });
        expect(result.title).toBe("OpenRouter title");
        expect(capturedEnvironment?.OPENROUTER_API_KEY).toBe("driver-sentinel-key");
        expect(capturedEnvironment?.OPENCODE_CONFIG_CONTENT).not.toContain("driver-sentinel-key");
        expect(JSON.parse(capturedEnvironment?.OPENCODE_CONFIG_CONTENT ?? "{}")).toMatchObject({
          provider: {
            openrouter: {
              options: { apiKey: "{env:OPENROUTER_API_KEY}" },
              models: { [modelSlug]: { name: "Test model" } },
            },
          },
        });
        expect(selected).toMatchObject({ model: { providerID: "openrouter", modelID: modelSlug } });
      }).pipe(Effect.provide(runtime));
    },
  );
});
