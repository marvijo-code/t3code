import { OpenRouterConnectionError, type OpenRouterConnectionResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";

const KeyResponse = Schema.Struct({
  data: Schema.Struct({
    limit_remaining: Schema.optionalKey(Schema.NullOr(Schema.Number.check(Schema.isFinite()))),
  }),
});

const isConnectionError = Schema.is(OpenRouterConnectionError);
const decodeKeyResponse = Schema.decodeUnknownEffect(KeyResponse);

export const testOpenRouterConnection = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const key = yield* settings.getSettings.pipe(
    Effect.map((s) => s.openRouter.apiKey),
    Effect.mapError(
      () =>
        new OpenRouterConnectionError({
          code: "missingKey",
          message: "Unable to read the saved OpenRouter key.",
        }),
    ),
  );
  if (!key)
    return yield* new OpenRouterConnectionError({
      code: "missingKey",
      message: "Save an OpenRouter API key first.",
    });
  const http = yield* HttpClient.HttpClient;
  return yield* http
    .get("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } })
    .pipe(
      Effect.flatMap((response) => {
        const status = response.status;
        if (status === 401 || status === 403)
          return Effect.fail(
            new OpenRouterConnectionError({
              code: "rejectedKey",
              message: "OpenRouter rejected the saved key.",
            }),
          );
        if (status === 429)
          return Effect.fail(
            new OpenRouterConnectionError({
              code: "rateLimited",
              message: "OpenRouter rate limited the check. Try again later.",
            }),
          );
        if (status < 200 || status >= 300)
          return Effect.fail(
            new OpenRouterConnectionError({
              code: "upstream",
              message: `OpenRouter key check failed (HTTP ${status}).`,
            }),
          );
        return response.json.pipe(
          Effect.flatMap(decodeKeyResponse),
          Effect.map((body): OpenRouterConnectionResult => ({
            success: true,
            limitRemaining: body.data.limit_remaining ?? null,
          })),
          Effect.mapError(
            () =>
              new OpenRouterConnectionError({
                code: "malformed",
                message: "OpenRouter returned an invalid key response.",
              }),
          ),
        );
      }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.timeout("10 seconds"),
      Effect.mapError((error) =>
        isConnectionError(error)
          ? error
          : new OpenRouterConnectionError({
              code: "network",
              message: "OpenRouter could not be reached. Try again.",
            }),
      ),
    );
});
