import { ProviderInstanceId } from "./providerInstance.ts";
import * as Schema from "effect/Schema";

export const OPENROUTER_HARNESSES = [
  {
    setting: "codex",
    instanceId: ProviderInstanceId.make("openrouter_codex"),
    driver: "codex",
    name: "OpenRouter (Codex)",
  },
  {
    setting: "claudeCode",
    instanceId: ProviderInstanceId.make("openrouter_claude"),
    driver: "claudeAgent",
    name: "OpenRouter (Claude Code)",
  },
  {
    setting: "openCode",
    instanceId: ProviderInstanceId.make("openrouter_opencode"),
    driver: "opencode",
    name: "OpenRouter (OpenCode)",
  },
] as const;

export const OpenRouterConnectionResult = Schema.Struct({
  success: Schema.Literal(true),
  limitRemaining: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
});
export type OpenRouterConnectionResult = typeof OpenRouterConnectionResult.Type;

export class OpenRouterConnectionError extends Schema.TaggedError<OpenRouterConnectionError>()(
  "OpenRouterConnectionError",
  {
    code: Schema.Literals([
      "missingKey",
      "rejectedKey",
      "rateLimited",
      "upstream",
      "network",
      "malformed",
    ]),
    message: Schema.String,
  },
) {}
