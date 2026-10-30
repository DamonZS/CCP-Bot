import { describe, expect, test } from "bun:test";
import { desktopTelemetryProperties } from "./desktop-telemetry";

describe("desktop runtime metadata", () => {
  test("leaves ordinary server deployments untagged", () => {
    expect(desktopTelemetryProperties({})).toEqual({});
    expect(
      desktopTelemetryProperties({ CCPBOT_DISTRIBUTION: "server" }),
    ).toEqual({});
  });

  test("carries only the shell's bounded metadata", () => {
    expect(
      desktopTelemetryProperties({
        CCPBOT_DISTRIBUTION: "desktop",
        CCPBOT_VERSION: "0.0.9",
        CCPBOT_PLATFORM: "macos",
        CCPBOT_ARCH: "aarch64",
        CCPBOT_OS_VERSION: "15.6.1",
        CCPBOT_ENGINE: "podman",
        OPENAI_API_KEY: "synthetic-secret",
        CPK_TELEMETRY_ID: "identity-belongs-in-the-transport",
        HOME: "/Users/private-name",
        CCPBOT_BASE_URL: "https://private.example",
      }),
    ).toEqual({
      ccpbot_distribution: "desktop",
      ccpbot_version: "0.0.9",
      ccpbot_platform: "macos",
      ccpbot_arch: "aarch64",
      ccpbot_os_version: "15.6.1",
      ccpbot_engine: "podman",
    });
  });

  test.each([
    "/Users/private-name",
    "private.example",
    "1.2-private-name",
    "1.2\nsecret",
    "1.2\n",
    "1.2.3.4.5",
    "1".repeat(40),
  ])("rejects arbitrary text in every metadata field: %s", (value) => {
    expect(
      desktopTelemetryProperties({
        CCPBOT_DISTRIBUTION: "desktop",
        CCPBOT_VERSION: value,
        CCPBOT_OS_VERSION: value,
        CCPBOT_PLATFORM: value,
        CCPBOT_ARCH: value,
        CCPBOT_ENGINE: value,
      }),
    ).toEqual({ ccpbot_distribution: "desktop" });
  });
});
