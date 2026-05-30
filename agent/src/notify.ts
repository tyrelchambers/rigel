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
