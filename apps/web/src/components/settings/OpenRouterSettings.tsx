import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OpenRouterConnectionTestResult,
  OpenRouterHarness,
} from "@t3tools/contracts";
import { type FormEvent, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { describeOpenRouterConnectionTest, readOpenRouterState } from "./OpenRouterSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * OpenRouter setup for one environment: a write-only key, a connection test, and one switch per
 * harness. The server owns every change; this only reflects settings and sends commands.
 */
export function OpenRouterSettings({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .openRouter === true;
  const configure = useAtomCommand(serverEnvironment.configureOpenRouter, {
    label: "update OpenRouter settings",
  });
  const testConnection = useAtomCommand(serverEnvironment.testOpenRouterConnection, {
    label: "test the OpenRouter connection",
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    readonly harness: OpenRouterHarness;
    readonly enabled: boolean;
  } | null>(null);
  const [test, setTest] = useState<OpenRouterConnectionTestResult | null>(null);

  const state = readOpenRouterState(settings);

  // Hold the requested position until settings catch up, so a slow relay does not
  // flash the old value between the response and the settings update.
  if (
    pending !== null &&
    state.harnesses.find((entry) => entry.harness === pending.harness)?.enabled === pending.enabled
  ) {
    setPending(null);
  }

  if (!supported) return null;

  const draftKey = draft.trim();
  const inputId = `openrouter-api-key-${environmentId}`;
  const tested = test ? describeOpenRouterConnectionTest(test) : null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (draftKey.length === 0) return;
    void run(async () => {
      const result = await configure({ environmentId, input: { apiKey: draftKey } });
      if (result._tag === "Success") {
        setDraft("");
        setTest(null);
      }
    });
  };

  const remove = () =>
    void run(async () => {
      const result = await configure({ environmentId, input: { apiKey: "" } });
      if (result._tag === "Success") setTest(null);
    });

  const runTest = () =>
    void run(async () => {
      const result = await testConnection({
        environmentId,
        input: draftKey.length > 0 ? { apiKey: draftKey } : {},
      });
      setTest(
        result._tag === "Success"
          ? result.value
          : { status: "error", reason: "unreachable", message: "Could not test the connection." },
      );
    });

  const toggle = (harness: OpenRouterHarness, enabled: boolean) =>
    void run(async () => {
      setPending({ harness, enabled });
      const result = await configure({
        environmentId,
        input: { harnesses: { [harness]: enabled } },
      });
      // The server may settle elsewhere than asked (for example a reserved id in use).
      const settled =
        result._tag === "Success"
          ? readOpenRouterState(result.value).harnesses.find((entry) => entry.harness === harness)
              ?.enabled
          : undefined;
      if (settled !== enabled) setPending(null);
    });

  return (
    <SettingsSection {...searchableSetting("openrouter")}>
      <SettingsRow
        title="API key"
        description="Stored on this environment's server. It is never shown again after saving."
        status={state.keySaved ? "A key is saved." : "No key saved."}
      >
        <form className="grid gap-3 pb-3" onSubmit={save}>
          {/* Locked while a request runs: a successful save clears the draft. */}
          <fieldset disabled={readOnly || busy} className="contents">
            <div className="grid gap-1.5">
              <Label htmlFor={inputId}>OpenRouter API key</Label>
              <Input
                id={inputId}
                type="password"
                autoComplete="off"
                size="sm"
                placeholder={
                  state.keySaved ? "Stored secret, enter a new value to replace" : "sk-or-..."
                }
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="xs" disabled={draftKey.length === 0}>
                Save key
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!state.keySaved && draftKey.length === 0}
                onClick={runTest}
              >
                Test connection
              </Button>
              {state.keySaved ? (
                <Button type="button" size="xs" variant="outline" onClick={remove}>
                  Remove key
                </Button>
              ) : null}
            </div>
            {tested ? (
              <p
                role="status"
                className={
                  tested.tone === "success"
                    ? "text-xs text-success-foreground"
                    : "text-xs text-destructive"
                }
              >
                {tested.text}
              </p>
            ) : null}
          </fieldset>
        </form>
      </SettingsRow>
      {state.harnesses.map((entry) => (
        <SettingsRow
          key={entry.harness}
          title={entry.label}
          description={
            entry.reservedIdInUse
              ? `Unavailable: your provider instance "${entry.instanceId}" already uses this id. Rename it to add ${entry.displayName}.`
              : `Adds the ${entry.displayName} provider, with OpenRouter's models.`
          }
          control={
            <Switch
              aria-label={`Use OpenRouter for ${entry.label}`}
              checked={pending?.harness === entry.harness ? pending.enabled : entry.enabled}
              disabled={readOnly || busy || !state.keySaved || entry.reservedIdInUse}
              onCheckedChange={(enabled) => toggle(entry.harness, enabled)}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}
