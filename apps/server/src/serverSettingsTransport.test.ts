import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, ServerSettings, WS_METHODS } from "@t3tools/contracts";
import { Effect, Queue, Schema, Stream } from "effect";
import { ServerSettingsService } from "./serverSettings.ts";
import { makeServerSettingsTransport } from "./serverSettingsTransport.ts";
import { authorizeEffectForScopes, requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";

const decode = Schema.decodeUnknownSync(ServerSettings);
it.effect(
  "OpenRouter transport redacts bootstrap, get/update replies and settings notifications",
  () =>
    Effect.gen(function* () {
      const key = "transport-key-sentinel";
      let settings = decode({ openRouter: { apiKey: key, codex: true } });
      const queue = yield* Queue.unbounded<ServerSettings>();
      const transport = makeServerSettingsTransport(
        ServerSettingsService.of({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.sync(() => settings),
          updateSettings: () =>
            Effect.gen(function* () {
              settings = {
                ...settings,
                openRouter: { ...settings.openRouter, apiKey: "rotated-transport-sentinel" },
              };
              yield* Queue.offer(queue, settings);
              return settings;
            }),
          streamChanges: Stream.fromQueue(queue),
          subscribeChanges: Effect.succeed(Stream.fromQueue(queue)),
        }),
      );
      // Bootstrap and server.getSettings share this exact getter in ws.ts.
      const bootstrap = { settings: yield* transport.get };
      const getReply = yield* transport.get;
      const updateReply = yield* transport.update({
        openRouter: { apiKey: "rotated-transport-sentinel" },
      });
      const notifications = yield* transport.changes.pipe(Stream.take(1), Stream.runCollect);
      for (const payload of [bootstrap, getReply, updateReply, notifications]) {
        expect(JSON.stringify(payload)).not.toContain(key);
        expect(JSON.stringify(payload)).not.toContain("rotated-transport-sentinel");
      }
      expect(getReply.openRouter.apiKey).toBe("••••••");
      expect(updateReply.openRouter.apiKey).toBe("••••••");
      expect(notifications[0]).toMatchObject({
        type: "settingsUpdated",
        payload: { settings: { openRouter: { apiKey: "••••••" } } },
      });
    }),
);

it.effect("OpenRouter key-test RPC rejects read-only callers before executing the key check", () =>
  Effect.gen(function* () {
    let executed = false;
    const check = Effect.sync(() => {
      executed = true;
      return true;
    });
    const denied = yield* authorizeEffectForScopes(
      [AuthOrchestrationReadScope],
      requiredScopeForRpcMethod(WS_METHODS.serverTestOpenRouterConnection),
      check,
    ).pipe(Effect.result);
    expect(denied._tag).toBe("Failure");
    expect(executed).toBe(false);
  }),
);
