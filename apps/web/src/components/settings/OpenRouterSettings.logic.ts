import {
  OPENROUTER_HARNESSES,
  resolveProviderInstanceEnabled,
  type OpenRouterConnectionTestResult,
  type ServerSettings,
} from "@t3tools/contracts";

/** What the OpenRouter section shows, derived from settings alone. */
export function readOpenRouterState(
  settings: Pick<ServerSettings, "openRouter" | "providerInstances">,
) {
  return {
    // Clients only ever see a redaction marker here, never the key.
    keySaved: settings.openRouter.apiKey.length > 0,
    harnesses: OPENROUTER_HARNESSES.map((entry) => {
      const instance = settings.providerInstances[entry.instanceId];
      return {
        harness: entry.harness,
        label: entry.label,
        displayName: entry.displayName,
        enabled:
          instance !== undefined &&
          instance.driver === entry.driver &&
          resolveProviderInstanceEnabled(instance),
      };
    }),
  };
}

const usd = (value: number) => `$${value.toFixed(2)}`;

export function describeOpenRouterConnectionTest(result: OpenRouterConnectionTestResult): {
  readonly tone: "success" | "error";
  readonly text: string;
} {
  if (result.status === "error") return { tone: "error", text: result.message };
  if (result.limit === 0 || (result.limitRemaining !== null && result.limitRemaining <= 0)) {
    return { tone: "error", text: "No credit remaining on this key." };
  }
  const credit =
    result.limit === null
      ? result.usage === null
        ? "No spending limit on this key."
        : `No spending limit on this key. ${usd(result.usage)} used.`
      : result.limitRemaining === null
        ? `${usd(result.limit)} limit.`
        : `${usd(result.limitRemaining)} of ${usd(result.limit)} remaining.`;
  return {
    tone: "success",
    text: `Connected${result.label ? ` as ${result.label}` : ""}. ${credit}`,
  };
}
