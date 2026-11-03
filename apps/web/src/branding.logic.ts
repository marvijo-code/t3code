const NIGHTLY_SERVER_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly primaryServerVersion: string | null | undefined;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    primaryServerVersion: input.primaryServerVersion,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}

/**
 * Identity of the running client: its version and when it was built. Shown so a
 * window can be matched against a build without restarting anything.
 */
export function formatBuildStamp(input: {
  readonly version: string;
  readonly buildTime: string;
}): string {
  const version = input.version.trim();
  const buildTime = formatBuildTime(input.buildTime);
  if (buildTime === null) {
    return version.length === 0 ? "" : `v${version}`;
  }
  return version.length === 0 ? buildTime : `v${version} - ${buildTime}`;
}

function formatBuildTime(value: string): string | null {
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const date = new Date(parsed);
  const pad = (part: number) => String(part).padStart(2, "0");
  // Local time, because the reader compares it against the clock in front of them.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
