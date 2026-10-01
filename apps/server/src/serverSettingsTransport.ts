import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ServerSettingsPatch } from "@t3tools/contracts";
import { redactServerSettingsForClient, type ServerSettingsService } from "./serverSettings.ts";

/** Client boundaries share the redacted view; internal consumers retain the saved credentials. */
export function makeServerSettingsTransport(service: ServerSettingsService["Service"]) {
  return {
    get: service.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
    update: (patch: ServerSettingsPatch) =>
      service.updateSettings(patch).pipe(Effect.map(redactServerSettingsForClient)),
    changes: service.streamChanges.pipe(
      Stream.map(redactServerSettingsForClient),
      Stream.map((settings) => ({
        version: 1 as const,
        type: "settingsUpdated" as const,
        payload: { settings },
      })),
    ),
  };
}
