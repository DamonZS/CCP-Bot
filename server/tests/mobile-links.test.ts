import { expect, test } from "bun:test";
import { notificationDestination } from "../../mobile/src/links";

test("native push opens only known screens and preserves canonical owner-scoped conversation IDs", () => {
  expect(
    notificationDestination({
      url: "ccpbotmobile://conversation?channelId=channel",
    }),
  ).toEqual({ pathname: "/conversation", params: { channelId: "channel" } });
  expect(
    notificationDestination({
      url: "ccpbotmobile://approvals?channelId=channel&requestId=q1",
    }),
  ).toEqual({
    pathname: "/approvals",
    params: { channelId: "channel", requestId: "q1" },
  });
  for (const url of [
    "https://evil.test",
    "ccpbotmobile://attacker?channelId=c",
    "ccpbotmobile://conversation/evil?channelId=c",
    "ccpbotmobile://conversation",
    "ccpbotmobile://user:password@conversation?channelId=c",
  ])
    expect(notificationDestination({ url })).toBeNull();
});
