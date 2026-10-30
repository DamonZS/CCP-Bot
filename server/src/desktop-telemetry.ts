/** Only the desktop shell's closed metadata may join the runtime's existing events. */
export function desktopTelemetryProperties(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (env.CCPBOT_DISTRIBUTION !== "desktop") return {};

  const properties: Record<string, string> = {
    ccpbot_distribution: "desktop",
  };
  for (const [input, output, allowed] of [
    [
      "CCPBOT_PLATFORM",
      "ccpbot_platform",
      ["macos", "windows", "linux", "other"],
    ],
    ["CCPBOT_ARCH", "ccpbot_arch", ["aarch64", "x86_64", "other"]],
    ["CCPBOT_ENGINE", "ccpbot_engine", ["docker", "podman", "none"]],
  ] as const) {
    const value = env[input];
    if (value && allowed.some((item) => item === value))
      properties[output] = value;
  }
  for (const [input, output] of [
    ["CCPBOT_VERSION", "ccpbot_version"],
    ["CCPBOT_OS_VERSION", "ccpbot_os_version"],
  ] as const) {
    const value = env[input];
    if (
      value &&
      value.length <= 32 &&
      value.trim() === value &&
      /^\d+(?:\.\d+){1,3}$/.test(value)
    ) {
      properties[output] = value;
    }
  }
  return properties;
}
