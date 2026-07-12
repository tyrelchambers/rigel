// Channel test-send proxy — server side of the Discord/Slack "Send test"
// button (mirrors matrix.ts). Signal and Matrix have their own bespoke
// connect/test flows (signal.ts's bridge poll, matrix.ts's room wizard); this
// module only serves the url-backed channels.
//
// POST /api/channels dispatches on `action`:
//   sendTest → POST the channel's test payload to `url`, returns { ok: true }.
//
// All calls are outbound HTTP to the user's webhook URL (no kubectl). Never
// throws — failures return a { kind: "error" } so the route picks the status.

import type { ChannelId } from "@rigel/k8s/src/channels";

export type ChannelResult =
  | { kind: "json"; body: unknown }
  | { kind: "error"; status: number; message: string };

export interface ChannelTestRequest {
  action: "sendTest";
  channel: ChannelId;
  url?: string;
}

const TEST_MESSAGE = (label: string) => `👋 Test from Rigel — your ${label} channel is connected.`;

function discordTestBody(): unknown {
  return { content: TEST_MESSAGE("Discord") };
}

function slackTestBody(): unknown {
  return { text: TEST_MESSAGE("Slack") };
}

/** Route a parsed channel test request. Never throws — see the module header. */
export async function handleChannelTest(req: ChannelTestRequest): Promise<ChannelResult> {
  try {
    if (req.action !== "sendTest") {
      return { kind: "error", status: 422, message: `unknown action: ${String((req as { action?: string }).action)}` };
    }
    let body: unknown;
    switch (req.channel) {
      case "discord":
        body = discordTestBody();
        break;
      case "slack":
        body = slackTestBody();
        break;
      default:
        return { kind: "error", status: 422, message: `unsupported channel: ${String(req.channel)}` };
    }
    const url = (req.url ?? "").trim();
    if (url === "") return { kind: "error", status: 422, message: "Paste the webhook URL first." };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { kind: "error", status: 502, message: `Send test failed: HTTP ${res.status}` };
    }
    return { kind: "json", body: { ok: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", status: 502, message: `Send test failed: ${message}` };
  }
}
