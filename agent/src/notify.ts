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
