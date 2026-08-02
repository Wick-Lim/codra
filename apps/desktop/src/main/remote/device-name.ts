const DEVICE_DISPLAY_NAME_MAX_LENGTH = 200;
const DEFAULT_DEVICE_DISPLAY_NAME = "CODRA host";

export function resolveDeviceDisplayName(hostname: string): string {
  const trimmed = hostname
    .trim()
    .replace(/\.local\.?$/iu, "")
    .trim();
  if (trimmed.length === 0) return DEFAULT_DEVICE_DISPLAY_NAME;
  return trimmed.slice(0, DEVICE_DISPLAY_NAME_MAX_LENGTH);
}
