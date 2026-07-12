// Notification channels — the shared domain generalizing Signal, Matrix,
// Discord, Slack, and the generic webhook into one descriptor table. Pure
// functions over the assistant-config ConfigMap `data` (no kubectl, no I/O).
// Signal/Matrix keep their own modules (signal.ts/matrix.ts) for
// bridge/manifest concerns; this module only reuses their config predicates.

import { hasSavedNumber } from "./signal.js";
import { deriveMatrixConnected } from "./matrix.js";

export type ChannelId = "signal" | "matrix" | "discord" | "slack" | "webhook";

export const DISCORD_WEBHOOK_URL_KEY = "discordWebhookUrl";
export const SLACK_WEBHOOK_URL_KEY = "slackWebhookUrl";
export const NOTIFY_CHANNELS_KEY = "notifyChannels";

const SIGNAL_KEYS = ["signalApiUrl", "signalNumber", "signalRecipients"] as const;
const MATRIX_KEYS = [
  "matrixHomeserverUrl",
  "matrixUserId",
  "matrixRoomId",
  "matrixAllowedSenders",
] as const;

export interface ChannelDescriptor {
  id: ChannelId;
  label: string;
  chat: boolean;
  configKeys: readonly string[];
  isConfigured(data: Record<string, string>): boolean;
  disconnectUpdates(): Record<string, string>;
}

function nonEmpty(data: Record<string, string>, key: string): boolean {
  return (data[key] ?? "").trim() !== "";
}

function clearKeys(keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = "";
  return out;
}

/** Outbound-only channel backed by a single webhook-URL config key. */
function urlChannel(id: ChannelId, label: string, key: string): ChannelDescriptor {
  return {
    id,
    label,
    chat: false,
    configKeys: [key],
    isConfigured: (data) => nonEmpty(data, key),
    disconnectUpdates: () => clearKeys([key]),
  };
}

export const CHANNELS: Record<ChannelId, ChannelDescriptor> = {
  signal: {
    id: "signal",
    label: "Signal",
    chat: true,
    configKeys: SIGNAL_KEYS,
    isConfigured: (data) => hasSavedNumber(data),
    disconnectUpdates: () => clearKeys(SIGNAL_KEYS),
  },
  matrix: {
    id: "matrix",
    label: "Matrix",
    chat: true,
    configKeys: MATRIX_KEYS,
    isConfigured: (data) => deriveMatrixConnected(data),
    disconnectUpdates: () => clearKeys(MATRIX_KEYS),
  },
  discord: urlChannel("discord", "Discord", DISCORD_WEBHOOK_URL_KEY),
  slack: urlChannel("slack", "Slack", SLACK_WEBHOOK_URL_KEY),
  webhook: urlChannel("webhook", "Generic webhook", "webhookUrl"),
};

const CHANNEL_ORDER = Object.keys(CHANNELS) as ChannelId[];

/** All configured channel ids, in stable CHANNEL_ORDER. */
export function connectedChannels(data: Record<string, string>): ChannelId[] {
  return CHANNEL_ORDER.filter((id) => CHANNELS[id].isConfigured(data));
}

/** Filter `updates` down to the keys `channel` is allowed to write. */
export function channelConfigUpdates(
  channel: ChannelId,
  updates: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(CHANNELS[channel].configKeys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

const CHANNEL_ID_SET = new Set<string>(CHANNEL_ORDER);

function isChannelId(s: string): s is ChannelId {
  return CHANNEL_ID_SET.has(s);
}

/** Parses `notifyChannels`; null means the key is absent (legacy install). */
export function parseNotifyAllowlist(data: Record<string, string>): ChannelId[] | null {
  const raw = data[NOTIFY_CHANNELS_KEY];
  if (raw === undefined) return null;
  const seen = new Set<ChannelId>();
  for (const s of raw.split(",")) {
    const trimmed = s.trim();
    if (trimmed && isChannelId(trimmed)) seen.add(trimmed);
  }
  return CHANNEL_ORDER.filter((id) => seen.has(id));
}

/** Intersect an already-computed configured set with the notify allowlist.
 *  null allowlist (legacy install, key absent) → broadcast to everything
 *  configured. Pure; the `complete` set's presence policy is the caller's
 *  concern (the server reads the ConfigMap; the agent additionally sees the
 *  Secret-injected Matrix token), so only this trailing intersect is shared. */
export function applyNotifyAllowlist(complete: ChannelId[], allowlist: ChannelId[] | null): ChannelId[] {
  if (allowlist === null) return complete;
  return complete.filter((id) => allowlist.includes(id));
}

/** The effective set of channels that should receive alert/remediation broadcasts. */
export function notifyEnabledChannels(data: Record<string, string>): ChannelId[] {
  return applyNotifyAllowlist(connectedChannels(data), parseNotifyAllowlist(data));
}

/** Build the `notifyChannels` patch for toggling one channel on/off, materializing
 *  the current effective set first when the key is still absent. */
export function setNotifyAllowlist(
  data: Record<string, string>,
  channel: ChannelId,
  enabled: boolean,
): Record<string, string> {
  const current = parseNotifyAllowlist(data) ?? connectedChannels(data);
  const next = new Set(current);
  if (enabled) next.add(channel);
  else next.delete(channel);
  const value = CHANNEL_ORDER.filter((id) => next.has(id)).join(",");
  return { [NOTIFY_CHANNELS_KEY]: value };
}
