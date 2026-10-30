/** Why Connect with CCP-Bot Desktop did not connect this browser, one plain sentence per code: CCP-Bot Desktop's own
 * error codes, and the Recorder's (no answer, the policy, an address it cannot use, CCP-Bot not taking Desktop's code). */
const SENTENCES: Record<string, string> = {
  "origin-not-allowed":
    "CCP-Bot Desktop does not recognise this copy of the Recorder. Connect from CCP-Bot in your browser instead.",
  "not-installed":
    "CCP-Bot Desktop has not set up CCP-Bot on this computer yet. Finish setting it up in CCP-Bot Desktop, then try again.",
  "not-running":
    "CCP-Bot is not running in CCP-Bot Desktop. Open CCP-Bot Desktop, then try again.",
  "not-signed-in":
    "CCP-Bot Desktop is not signed in to your organization. Sign in again in CCP-Bot Desktop, then try again.",
  "organization-unavailable":
    "CCP-Bot Desktop cannot hand over your organization sign-in right now. Try again later.",
  "handoff-failed":
    "CCP-Bot did not give CCP-Bot Desktop a code to connect with. Try again.",
  "timed-out": "CCP-Bot Desktop did not answer in time. Try again.",
  "no-answer": "CCP-Bot Desktop did not answer. Open it, then try again.",
  "host-failed":
    "CCP-Bot Desktop ran into a problem while answering. Try again, or connect from CCP-Bot in your browser.",
  "unknown-message":
    "This version of CCP-Bot Desktop does not understand the Recorder. Update CCP-Bot Desktop, then try again.",
  "policy-invalid":
    "Your organization's Recorder policy names a CCP-Bot address the Recorder cannot use. Ask your IT team.",
  "pinned-elsewhere":
    "Your organization connects the Recorder to a different CCP-Bot. Connect from that CCP-Bot instead.",
  "invalid-address":
    "CCP-Bot Desktop answered with an address the Recorder cannot use. Connect from CCP-Bot in your browser instead.",
  "exchange-refused":
    "CCP-Bot did not accept the code CCP-Bot Desktop gave the Recorder. Try again.",
  "ccpbot-unreachable":
    "CCP-Bot did not answer. Make sure CCP-Bot is running in CCP-Bot Desktop, then try again.",
};

const UNKNOWN =
  "CCP-Bot Desktop could not connect this browser. Try again, or connect from CCP-Bot in your browser.";

export function desktopSentence(code: string): string {
  return Object.hasOwn(SENTENCES, code) ? (SENTENCES[code] as string) : UNKNOWN;
}
