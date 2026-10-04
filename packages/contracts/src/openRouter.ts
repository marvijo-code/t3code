import * as Schema from "effect/Schema";
import { TrimmedString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const OpenRouterHarness = Schema.Literals(["codex", "claudeAgent", "opencode"]);
export type OpenRouterHarness = typeof OpenRouterHarness.Type;

/**
 * The provider instances OpenRouter setup owns, one per harness. The instance id is reserved:
 * an instance with this id, driver and the `integration: "openrouter"` marker gets OpenRouter's
 * model catalog and is what the settings switch turns on and off. An instance a user created
 * under the same id has no marker and is never changed. `harness` equals the driver kind.
 */
export const OPENROUTER_HARNESSES = [
  {
    harness: "codex",
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("openrouter_codex"),
    label: "Codex",
    displayName: "OpenRouter (Codex)",
  },
  {
    harness: "claudeAgent",
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("openrouter_claude"),
    label: "Claude Code",
    displayName: "OpenRouter (Claude Code)",
  },
  {
    harness: "opencode",
    driver: ProviderDriverKind.make("opencode"),
    instanceId: ProviderInstanceId.make("openrouter_opencode"),
    label: "OpenCode",
    displayName: "OpenRouter (OpenCode)",
  },
] as const satisfies ReadonlyArray<{
  readonly harness: OpenRouterHarness;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly displayName: string;
}>;

export const isOpenRouterInstance = (
  instanceId: string,
  instance: { readonly driver: string; readonly integration?: string | undefined } | undefined,
): boolean =>
  instance?.integration === "openrouter" &&
  OPENROUTER_HARNESSES.some(
    (entry) => entry.instanceId === instanceId && entry.driver === instance.driver,
  );

export const OpenRouterConfigureInput = Schema.Struct({
  /** New key. Empty removes the key and turns every harness off. Omitted keeps the saved key. */
  apiKey: Schema.optionalKey(TrimmedString),
  /** Harnesses to switch. Omitted harnesses keep their state. */
  harnesses: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(Schema.Boolean),
      claudeAgent: Schema.optionalKey(Schema.Boolean),
      opencode: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type OpenRouterConfigureInput = typeof OpenRouterConfigureInput.Type;

export const OpenRouterConnectionTestInput = Schema.Struct({
  /** A key typed but not saved yet. Omitted or empty tests the saved key. */
  apiKey: Schema.optionalKey(TrimmedString),
});
export type OpenRouterConnectionTestInput = typeof OpenRouterConnectionTestInput.Type;

export const OpenRouterConnectionTestResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    /** OpenRouter's masked label for the key, never the key itself. */
    label: Schema.NullOr(Schema.String),
    usage: Schema.NullOr(Schema.Number),
    limit: Schema.NullOr(Schema.Number),
    limitRemaining: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    reason: Schema.Literals(["missing-key", "invalid-key", "unreachable", "unexpected-response"]),
    message: Schema.String,
  }),
]);
export type OpenRouterConnectionTestResult = typeof OpenRouterConnectionTestResult.Type;
