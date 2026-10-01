import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ClaudeSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import {
  OpenRouterDriverTestLayer,
  runtimeEntry,
  modelSlug,
  models,
} from "./OpenRouterDriver.testFixtures.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { ServerConfig } from "../../config.ts";
const decode = Schema.decodeUnknownSync(ClaudeSettings);

it.layer(OpenRouterDriverTestLayer)("OpenRouter ClaudeDriver", (it) => {
  it.effect(
    "passes settings credentials, isolated config home and the exact model into CLI text generation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const directory = yield* fs.makeTempDirectoryScoped();
        const capture = path.join(directory, "capture.json");
        const binaryPath = writeFakeCli({
          directory,
          name: "claude",
          source: `
      import { writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      if (args.includes("--version")) { console.log("claude 2.1.219"); process.exit(0); }
      for await (const chunk of process.stdin) {}
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args, env: {
        HOME: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR,
        base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY
      }}));
      console.log(JSON.stringify({structured_output:{title:"OpenRouter title"}}));
    `,
        });
        const entry = runtimeEntry(
          "claudeAgent",
          `~/${NodePath.relative(NodeOS.homedir(), binaryPath)}`,
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawned: string[] = [];
        const recordingSpawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawned.push(command.command);
          return spawner.spawn(command);
        });
        const instance = yield* ClaudeDriver.create({
          ...entry,
          enabled: true,
          displayName: entry.displayName,
          environment: entry.environment ?? [],
          config: decode(entry.config),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            // Supply synthetic machine policy instead of reading host provider configuration.
            readFileString: (file) =>
              file.startsWith(directory) || file.startsWith(config.stateDir)
                ? fs.readFileString(file)
                : Effect.succeed("{}"),
          }),
        );
        expect((yield* instance.snapshot.getSnapshot).models).toEqual(models);
        expect(instance.consumeResetCredit).toBeUndefined();
        const skillDirectory = path.join(directory, ".claude", "skills", "workspace-skill");
        yield* fs.makeDirectory(skillDirectory, { recursive: true });
        yield* fs.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          "---\ndescription: Workspace skill\n---\nTest",
        );
        expect((yield* instance.snapshotForCwd!(directory)).skills).toEqual([
          expect.objectContaining({ name: "workspace-skill", scope: "project" }),
        ]);
        const presentation = yield* instance.snapshot.getSnapshot;
        expect(presentation.supportsConversationRollback).not.toBe(false);
        expect(presentation.reportsContextWindow).toBe(true);
        expect(presentation.showInteractionModeToggle).toBe(true);
        const result = yield* instance.textGeneration.generateThreadTitle({
          cwd: directory,
          message: "Test",
          modelSelection: createModelSelection(entry.instanceId, modelSlug),
        });
        expect(result.title).toBe("OpenRouter title");
        expect(
          spawned.filter((command) => command.includes(binaryPath)).length,
        ).toBeGreaterThanOrEqual(2);
        expect(spawned.some((command) => command.startsWith("~"))).toBe(false);
        const captured = JSON.parse(yield* fs.readFileString(capture));
        expect(captured.args).toContain(modelSlug);
        expect(captured.args.join(" ")).not.toContain("driver-sentinel-key");
        expect(captured.env).toEqual({
          HOME: process.env.HOME,
          config: path.join(config.stateDir, "provider-homes", entry.instanceId),
          base: "https://openrouter.ai/api",
          token: "driver-sentinel-key",
          key: "",
        });
      }),
  );
});
