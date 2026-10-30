import { isAllowedGatewayUrl, normaliseCcpBotOrigin } from "./origin";

/** `ccpbotUrlInvalid`: the policy names an address normaliseCcpBotOrigin refuses; every connect is then refused. */
export type RecorderPolicy = {
  ccpbotUrl: string | null;
  ccpbotUrlInvalid: boolean;
  allowedIntelligenceUrls: string[] | null;
};

function ccpbotUrlFrom(
  value: unknown,
): Pick<RecorderPolicy, "ccpbotUrl" | "ccpbotUrlInvalid"> {
  if (value === undefined)
    return { ccpbotUrl: null, ccpbotUrlInvalid: false };
  const checked =
    typeof value === "string" ? normaliseCcpBotOrigin(value.trim()) : null;
  // The bad string is dropped here, so no surface can show or parse it.
  return checked?.ok
    ? { ccpbotUrl: checked.origin, ccpbotUrlInvalid: false }
    : { ccpbotUrl: null, ccpbotUrlInvalid: true };
}

/** Absent: no restriction. Present: only the valid wss:// entries (ws:// for a loopback IP); none left refuses every pass.
 *
 * Chrome publishes a managed value only when it matches managed_schema.json, and a schema names exactly one type, so a
 * value IT wrote with the wrong type (a single string, a Windows REG_MULTI_SZ) never reaches this function: it reads as
 * absent, no restriction. No schema can widen that, so the schema's description and the company install guide tell IT
 * to check chrome://policy. The non-list branch below is a guard for a Chrome that published one anyway. */
function allowedUrlsFrom(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && isAllowedGatewayUrl(entry, null),
  );
}

function policyFrom(managed: Record<string, unknown>): RecorderPolicy {
  return {
    ...ccpbotUrlFrom(managed.CcpBotUrl),
    allowedIntelligenceUrls: allowedUrlsFrom(managed.AllowedIntelligenceUrls),
  };
}

export async function readPolicy(): Promise<RecorderPolicy> {
  return policyFrom(await chrome.storage.managed.get(null));
}

/** Whether the policy lets this browser connect to (and stay connected to) `origin`: never under an invalid policy,
 * and only to the pinned CCP-Bot when one is pinned. */
export function allowsCcpBot(policy: RecorderPolicy, origin: string): boolean {
  if (policy.ccpbotUrlInvalid) return false;
  if (policy.ccpbotUrl === null) return true;
  const checked = normaliseCcpBotOrigin(origin);
  return checked.ok && checked.origin === policy.ccpbotUrl;
}

export function onPolicyChanged(
  listener: (policy: RecorderPolicy) => void,
  read: () => Promise<RecorderPolicy> = readPolicy,
): () => void {
  const onChanged = (_changes: unknown, area: string) => {
    if (area !== "managed") return;
    void read().then(listener);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
