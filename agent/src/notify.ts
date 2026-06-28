import { chunkText } from "./signalInbound.js";

/**
 * Best-effort outbound notification when the agent acts or queues something.
 * Posts a Slack/Discord/Mattermost-compatible {text} JSON body to the
 * configured webhook URL. Never throws — notification failure must not affect
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
