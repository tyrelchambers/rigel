// packages/k8s/src/channels.test.ts
import { test, expect } from "vitest";
import {
  CHANNELS,
  connectedChannels,
  channelConfigUpdates,
  parseNotifyAllowlist,
  notifyEnabledChannels,
  setNotifyAllowlist,
  DISCORD_WEBHOOK_URL_KEY,
  SLACK_WEBHOOK_URL_KEY,
  NOTIFY_CHANNELS_KEY,
} from "./channels";

const allConfigured: Record<string, string> = {
  signalNumber: "+1555",
  matrixHomeserverUrl: "https://hs",
  matrixUserId: "@r:hs",
  matrixRoomId: "!x:hs",
  discordWebhookUrl: "https://discord.com/api/webhooks/x",
  slackWebhookUrl: "https://hooks.slack.com/services/x",
  webhookUrl: "https://example.com/hook",
};

test("isConfigured: signal requires a saved number", () => {
  expect(CHANNELS.signal.isConfigured({})).toBe(false);
  expect(CHANNELS.signal.isConfigured({ signalNumber: "  " })).toBe(false);
  expect(CHANNELS.signal.isConfigured({ signalNumber: "+1555" })).toBe(true);
});

test("isConfigured: matrix requires homeserver+userId+roomId", () => {
  expect(CHANNELS.matrix.isConfigured({})).toBe(false);
  expect(
    CHANNELS.matrix.isConfigured({ matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs" }),
  ).toBe(false);
  expect(
    CHANNELS.matrix.isConfigured({
      matrixHomeserverUrl: "https://hs",
      matrixUserId: "@r:hs",
      matrixRoomId: "!x:hs",
    }),
  ).toBe(true);
});

test("isConfigured: discord/slack/webhook require a non-empty, trimmed URL", () => {
  expect(CHANNELS.discord.isConfigured({})).toBe(false);
  expect(CHANNELS.discord.isConfigured({ [DISCORD_WEBHOOK_URL_KEY]: "  " })).toBe(false);
  expect(CHANNELS.discord.isConfigured({ [DISCORD_WEBHOOK_URL_KEY]: "https://x" })).toBe(true);

  expect(CHANNELS.slack.isConfigured({})).toBe(false);
  expect(CHANNELS.slack.isConfigured({ [SLACK_WEBHOOK_URL_KEY]: "https://x" })).toBe(true);

  expect(CHANNELS.webhook.isConfigured({})).toBe(false);
  expect(CHANNELS.webhook.isConfigured({ webhookUrl: "https://x" })).toBe(true);
});

test("chat flag: signal/matrix are two-way, the rest are outbound-only", () => {
  expect(CHANNELS.signal.chat).toBe(true);
  expect(CHANNELS.matrix.chat).toBe(true);
  expect(CHANNELS.discord.chat).toBe(false);
  expect(CHANNELS.slack.chat).toBe(false);
  expect(CHANNELS.webhook.chat).toBe(false);
});

test("connectedChannels returns exactly the configured ones in stable order", () => {
  expect(connectedChannels({})).toEqual([]);
  expect(connectedChannels(allConfigured)).toEqual([
    "signal",
    "matrix",
    "discord",
    "slack",
    "webhook",
  ]);
  expect(connectedChannels({ slackWebhookUrl: "https://x", signalNumber: "+1555" })).toEqual([
    "signal",
    "slack",
  ]);
});

test("channelConfigUpdates drops keys not owned by the channel", () => {
  expect(
    channelConfigUpdates("discord", {
      [DISCORD_WEBHOOK_URL_KEY]: "https://d",
      [SLACK_WEBHOOK_URL_KEY]: "https://s",
      matrixRoomId: "!x:hs",
    }),
  ).toEqual({ [DISCORD_WEBHOOK_URL_KEY]: "https://d" });

  expect(
    channelConfigUpdates("signal", {
      signalNumber: "+1555",
      signalRecipients: "+1666",
      matrixUserId: "@r:hs",
    }),
  ).toEqual({ signalNumber: "+1555", signalRecipients: "+1666" });
});

test("disconnectUpdates clears exactly the channel's keys", () => {
  expect(CHANNELS.signal.disconnectUpdates()).toEqual({
    signalApiUrl: "",
    signalNumber: "",
    signalRecipients: "",
  });
  expect(CHANNELS.matrix.disconnectUpdates()).toEqual({
    matrixHomeserverUrl: "",
    matrixUserId: "",
    matrixRoomId: "",
    matrixAllowedSenders: "",
  });
  expect(CHANNELS.discord.disconnectUpdates()).toEqual({ [DISCORD_WEBHOOK_URL_KEY]: "" });
  expect(CHANNELS.slack.disconnectUpdates()).toEqual({ [SLACK_WEBHOOK_URL_KEY]: "" });
  expect(CHANNELS.webhook.disconnectUpdates()).toEqual({ webhookUrl: "" });
});

test("parseNotifyAllowlist is null when the key is absent", () => {
  expect(parseNotifyAllowlist({})).toBeNull();
});

test("parseNotifyAllowlist parses, cleans unknown/empty entries, and dedupes", () => {
  expect(parseNotifyAllowlist({ [NOTIFY_CHANNELS_KEY]: "signal,matrix" })).toEqual([
    "signal",
    "matrix",
  ]);
  expect(
    parseNotifyAllowlist({ [NOTIFY_CHANNELS_KEY]: " slack ,, sms , signal ,signal" }),
  ).toEqual(["signal", "slack"]);
  expect(parseNotifyAllowlist({ [NOTIFY_CHANNELS_KEY]: "" })).toEqual([]);
});

test("notifyEnabledChannels: legacy install (key absent) broadcasts to all connected", () => {
  expect(notifyEnabledChannels(allConfigured)).toEqual([
    "signal",
    "matrix",
    "discord",
    "slack",
    "webhook",
  ]);
});

test("notifyEnabledChannels: explicit allowlist intersects with connected", () => {
  const data = { ...allConfigured, [NOTIFY_CHANNELS_KEY]: "signal,webhook,discord" };
  expect(notifyEnabledChannels(data)).toEqual(["signal", "discord", "webhook"]);

  const dataUnconfigured = { ...allConfigured, [NOTIFY_CHANNELS_KEY]: "signal" };
  delete (dataUnconfigured as Record<string, string>).signalNumber;
  expect(notifyEnabledChannels(dataUnconfigured)).toEqual([]);
});

test("setNotifyAllowlist materializes the current effective set before toggling off", () => {
  const patch = setNotifyAllowlist(allConfigured, "matrix", false);
  expect(patch[NOTIFY_CHANNELS_KEY].split(",")).toEqual(
    expect.arrayContaining(["signal", "discord", "slack", "webhook"]),
  );
  expect(patch[NOTIFY_CHANNELS_KEY]).not.toContain("matrix");
});

test("setNotifyAllowlist adds/removes correctly once the key exists", () => {
  const withAllowlist = { ...allConfigured, [NOTIFY_CHANNELS_KEY]: "signal,matrix" };
  expect(setNotifyAllowlist(withAllowlist, "discord", true)[NOTIFY_CHANNELS_KEY]).toBe(
    "signal,matrix,discord",
  );
  expect(setNotifyAllowlist(withAllowlist, "signal", false)[NOTIFY_CHANNELS_KEY]).toBe("matrix");
});
