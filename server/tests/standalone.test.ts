import { describe, expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * A deployment with no CopilotKit Intelligence at all.
 *
 * The three settings that address the platform decide this, and all three have to be missing. A
 * partial set is still refused (see `runtimeCapabilities` in config.ts): an operator who set one of
 * the three meant to connect and got it wrong, and half a contract is worse than none.
 */
const standaloneEnvironment = (
  overrides: Record<string, string | undefined> = {},
) =>
  testEnvironment({
    INTELLIGENCE_API_URL: undefined,
    INTELLIGENCE_GATEWAY_WS_URL: undefined,
    INTELLIGENCE_API_KEY: undefined,
    ...overrides,
  });

describe("a deployment with no Intelligence", () => {
  test("boots in sse mode rather than refusing to start", () => {
    const config = loadConfig(standaloneEnvironment());

    expect(config.runtime).toEqual({ mode: "sse", durableHistory: false });
  });

  test("says so at boot, naming the three settings that would connect it", () => {
    const warned: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation(
      (...data: unknown[]) => {
        warned.push(String(data[0]));
      },
    );
    try {
      loadConfig(standaloneEnvironment());
    } finally {
      warn.mockRestore();
    }

    const said = warned
      .filter((line) => line.includes("intelligence-absent"))
      .map((line) => JSON.parse(line) as { mode: string; reason: string });

    expect(said).toHaveLength(1);
    expect(said[0]?.mode).toBe("sse");
    for (const key of [
      "INTELLIGENCE_API_URL",
      "INTELLIGENCE_GATEWAY_WS_URL",
      "CPK_INTELLIGENCE_API_KEY",
    ]) {
      expect(said[0]?.reason).toContain(key);
    }
  });

  test("still refuses a partial set, in the words it always used", () => {
    expect(() =>
      loadConfig(
        standaloneEnvironment({ INTELLIGENCE_API_KEY: "tenant-api-key" }),
      ),
    ).toThrow(
      "CopilotKit Intelligence is required and is not configured. Missing: INTELLIGENCE_API_URL, INTELLIGENCE_GATEWAY_WS_URL",
    );
  });

  test("answers /api/capabilities with sse and no durable history", async () => {
    const app = createApp(loadConfig(standaloneEnvironment()));

    const response = await app.request("http://ccpbot.local/api/capabilities");

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.mode).toBe("sse");
    expect(body.durableHistory).toBe(false);
    // The rest of the projection is unchanged: this is a capability answer, not a different product.
    expect(body.generativeUi).toBe(true);
    expect(body.localEvaluation).toBe(false);
    // No Intelligence settings may leak through the projection, in either mode.
    expect(Object.keys(body)).not.toContain("intelligence");
  });

  test("a deployment with all three settings still runs on Intelligence", () => {
    const config = loadConfig(testEnvironment());

    expect(config.runtime.mode).toBe("intelligence");
    expect(config.runtime.durableHistory).toBe(true);
  });
});