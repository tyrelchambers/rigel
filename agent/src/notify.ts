import { chunkText } from "./signalInbound.js";
import { applyNotifyAllowlist, type ChannelId } from "@rigel/k8s/src/channels.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

/**
 * Best-effort outbound notification when the agent acts or queues something.
 * Posts a Slack/Mattermost-compatible {text} JSON body to the configured
 * webhook URL. Never throws — notification failure must not affect
 * remediation.
 */
export async function notifyWebhook(url: string, text: string): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    // swallow — notifications are best-effort
  }
}

/**
 * Best-effort outbound notification to a native Discord webhook. Discord
 * rejects the Slack-style {text} body — it wants {content} — and hard-caps
 * each message at 2000 chars, so chunk there rather than at chunkText's
 * default. Never throws — notification failure must not affect remediation.
 */
export async function notifyDiscord(url: string, text: string): Promise<void> {
  for (const chunk of chunkText(text, 2000)) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: chunk }),
      });
    } catch {
      // swallow — notifications are best-effort
    }
  }
}

/**
 * Send via a self-hosted signal-cli-rest-api (`POST /v2/send`). `apiUrl` is the
 * service base URL, `sender` the linked number, `recipients` the destinations.
 * Best-effort; never throws.
 */
export async function notifySignal(
  apiUrl: string,
  sender: string,
  recipients: string[],
  text: string,
): Promise<void> {
  if (recipients.length === 0) return;
  try {
    await fetch(`${apiUrl.replace(/\/+$/, "")}/v2/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, number: sender, recipients }),
    });
  } catch {
    // swallow — notifications are best-effort
  }
}

/**
 * Drain pending inbound messages from signal-cli-rest-api
 * (`GET /v1/receive/{number}`). Works in the bridge's default `native` mode;
 * the call also acknowledges the messages server-side so they aren't redelivered.
 * Returns the parsed JSON array (the caller decodes it). Throws on a transport
 * or non-2xx error so inbound handling can log and skip this poll.
 */
export async function receiveSignal(apiUrl: string, number: string): Promise<unknown> {
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/receive/${encodeURIComponent(number)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`signal receive returned ${res.status}`);
  return res.json();
}

/**
 * Send a reply into a Matrix room via the client-server API
 * (`PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`). One PUT
 * per chunk, each with a unique transaction id. Best-effort; never throws —
 * notification failure must not affect remediation.
 */
export async function notifyMatrix(
  homeserver: string,
  accessToken: string,
  roomId: string,
  text: string,
): Promise<void> {
  const base = homeserver.replace(/\/+$/, "");
  for (const chunk of chunkText(text)) {
    const txnId = `rigel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await fetch(
        `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ msgtype: "m.text", body: chunk }),
        },
      );
    } catch {
      // swallow — notifications are best-effort
    }
  }
}

/**
 * POST a read receipt for `eventId` to mark the message as "seen" in the room.
 * Best-effort; never throws — receipt failure must not affect remediation.
 */
export async function markMatrixRead(
  homeserver: string,
  accessToken: string,
  roomId: string,
  eventId: string,
): Promise<void> {
  const base = homeserver.replace(/\/+$/, "");
  try {
    await fetch(
      `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: "{}",
      },
    );
  } catch {
    // swallow — best-effort
  }
}

/**
 * PUT a typing notification for the bot user into the room. Pass `typing: true`
 * while the agent is working, `typing: false` when it finishes. Best-effort;
 * never throws — typing indicator failure must not affect remediation.
 */
export async function setMatrixTyping(
  homeserver: string,
  accessToken: string,
  roomId: string,
  userId: string,
  typing: boolean,
  timeoutMs = 30000,
): Promise<void> {
  const base = homeserver.replace(/\/+$/, "");
  try {
    await fetch(
      `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(typing ? { typing: true, timeout: timeoutMs } : { typing: false }),
      },
    );
  } catch {
    // swallow — best-effort
  }
}

/**
 * Drain inbound events via `GET /_matrix/client/v3/sync` from the stored `since`
 * cursor (`timeout=0` for a non-blocking poll each tick). Returns the parsed JSON
 * (the caller decodes the room timeline). Throws on a transport or non-2xx error
 * so inbound handling can log and skip this poll.
 */
export async function receiveMatrix(
  homeserver: string,
  accessToken: string,
  since?: string,
): Promise<unknown> {
  const base = homeserver.replace(/\/+$/, "");
  const params = new URLSearchParams({ timeout: "0" });
  if (since) params.set("since", since);
  const res = await fetch(`${base}/_matrix/client/v3/sync?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`matrix sync returned ${res.status}`);
  return res.json();
}

const CHANNEL_ORDER: ChannelId[] = ["signal", "matrix", "discord", "slack", "webhook"];

/** Whether `channel` has everything it needs to send on this RuntimeConfig.
 *  The single source for "is X configured" — used by both sendToChannel's
 *  dispatch guard and runtimeCompleteChannels' filter. Matrix's token comes
 *  from a Secret (env), which is why this lives here, not in the ConfigMap-only
 *  packages/k8s domain helper. */
function isChannelConfigured(rc: RuntimeConfig, channel: ChannelId): boolean {
  switch (channel) {
    case "webhook": return !!rc.webhookUrl;
    case "signal": return !!(rc.signalApiUrl && rc.signalNumber);
    case "matrix": return !!(rc.matrix.homeserverUrl && rc.matrix.accessToken && rc.matrix.roomId);
    case "discord": return !!rc.discordWebhookUrl;
    case "slack": return !!rc.slackWebhookUrl;
  }
}

/** Dispatch `text` to one channel (best-effort). Shared by the broadcast path
 *  (flushNotifications) and digests (single-channel targeting). */
export async function sendToChannel(rc: RuntimeConfig, channel: ChannelId, text: string): Promise<void> {
  if (!isChannelConfigured(rc, channel)) return; // not configured → silently skip (best-effort)
  switch (channel) {
    case "webhook": return notifyWebhook(rc.webhookUrl!, text);
    case "signal": return notifySignal(rc.signalApiUrl!, rc.signalNumber!, rc.signalRecipients, text);
    case "matrix": return notifyMatrix(rc.matrix.homeserverUrl!, rc.matrix.accessToken!, rc.matrix.roomId!, text);
    case "discord": return notifyDiscord(rc.discordWebhookUrl!, text);
    case "slack": return notifyWebhook(rc.slackWebhookUrl!, text);
  }
}

/** The channels the agent considers runtime-complete right now (its own
 *  presence check — it sees the Secret-injected Matrix token the ConfigMap
 *  can't). Stable CHANNEL_ORDER. */
function runtimeCompleteChannels(rc: RuntimeConfig): ChannelId[] {
  return CHANNEL_ORDER.filter((id) => isChannelConfigured(rc, id));
}

/** The broadcast set for alert/remediation notifications: runtime-complete
 *  channels, filtered by the notify allowlist (null = legacy broadcast-all). */
export function notifyTargets(rc: RuntimeConfig): ChannelId[] {
  return applyNotifyAllowlist(runtimeCompleteChannels(rc), rc.notifyAllowlist);
}
