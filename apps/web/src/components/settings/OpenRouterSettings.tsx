import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OpenRouterConnectionError } from "@t3tools/contracts";
import type { EnvironmentId, OpenRouterSettings as OpenRouterConfig } from "@t3tools/contracts";
import { OPENROUTER_HARNESSES } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const isConnectionError = Schema.is(OpenRouterConnectionError);
const connectionMessages = {
  missingKey: "Save an OpenRouter API key first.",
  rejectedKey: "OpenRouter rejected the saved key.",
  rateLimited: "OpenRouter rate limited the check. Try again later.",
  upstream: "OpenRouter key check failed. Try again later.",
  network: "OpenRouter could not be reached. Try again.",
  malformed: "OpenRouter returned an invalid key response.",
} as const;

export function OpenRouterSettings({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const config = useEnvironmentSettings(environmentId, (s) => s.openRouter);
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const test = useAtomCommand(serverEnvironment.testOpenRouterConnection, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Incoming settings snapshots have a new identity even when both keys are redacted.
  const [testedConfig, setTestedConfig] = useState<OpenRouterConfig | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (operation: () => Promise<string>, isConnectionTest = false) => {
    if (readOnly || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const message = await operation();
      if (alive.current) {
        setStatus(message);
        setTestedConfig(isConnectionTest ? config : null);
      }
    } catch {
      if (alive.current) {
        setStatus("OpenRouter request failed. Try again.");
        setTestedConfig(isConnectionTest ? config : null);
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const update = (patch: Partial<OpenRouterConfig>) =>
    run(async () => {
      const result = await save({ environmentId, input: { patch: { openRouter: patch } } });
      if (result._tag !== "Success")
        return "OpenRouter settings could not be saved. Check the key and instance configuration.";
      if (alive.current && patch.apiKey !== undefined) setDraft("");
      return "OpenRouter settings saved.";
    });
  const disabled = readOnly || busy;
  return (
    <SettingsSection title="OpenRouter" {...searchableSetting("openrouter")}>
      <SettingsRow
        title="OpenRouter API key"
        description={config.apiKey ? "Key is set" : "Save a key on this environment."}
        control={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim()) void update({ apiKey: draft.trim() });
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="OpenRouter API key"
                type="password"
                autoComplete="off"
                value={draft}
                disabled={disabled}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setStatus("");
                }}
              />
              <Button type="submit" size="sm" disabled={disabled || !draft.trim()}>
                Save key
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || !config.apiKey || Boolean(draft)}
                onClick={() =>
                  void run(async () => {
                    const result = await test({ environmentId, input: {} });
                    if (result._tag !== "Success") {
                      const error = Cause.findErrorOption(result.cause);
                      return Option.isSome(error) && isConnectionError(error.value)
                        ? connectionMessages[error.value.code]
                        : "OpenRouter connection failed. Check the saved key and try again.";
                    }
                    return result.value.limitRemaining === null
                      ? "OpenRouter connection successful."
                      : `OpenRouter connection successful. Remaining key limit: ${result.value.limitRemaining}.`;
                  }, true)
                }
              >
                Test connection
              </Button>
              {config.apiKey ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void update({ apiKey: "" })}
                >
                  Remove key
                </Button>
              ) : null}
            </div>
          </form>
        }
      />
      {draft ? <p>Save key before testing</p> : null}
      {OPENROUTER_HARNESSES.map((h) => (
        <SettingsRow
          key={h.setting}
          title={h.name}
          control={
            <Switch
              aria-label={`Use OpenRouter for ${h.driver === "claudeAgent" ? "Claude Code" : h.driver === "codex" ? "Codex" : "OpenCode"}`}
              checked={config[h.setting]}
              disabled={disabled || !config.apiKey}
              onCheckedChange={(checked) => void update({ [h.setting]: checked })}
            />
          }
        />
      ))}
      <p>
        Key and switch changes reconnect the affected harness. Each harness executable is required.
      </p>
      <p role="status" aria-live="polite">
        {testedConfig !== null && testedConfig !== config ? "" : status}
      </p>
    </SettingsSection>
  );
}
