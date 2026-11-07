import { runModel } from "./runModel.js";
import { greeting } from "./notifyVoice.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

const SYSTEM_PROMPT = `You are the operator's personal assistant, texting them about their Kubernetes cluster. They are busy and do not want details.

Rewrite the updates below as one short text message, the way a capable human assistant would:
- Say what happened, what you did about it, and whether it's fixed now.
- If they need to do something, say exactly what, in one sentence. If not, don't mention them at all.
- Plain everyday words. No log lines, error codes, commands, pod names with hashes, IP addresses or jargon.
- Group related updates into one sentence. Two to four sentences total. No headings, no bullet points, no emoji.
- Never claim something is fixed unless an update says it was confirmed.`;

export function plainUpdate(lines: string[]): string {
  return `${greeting(lines)}\n${lines.join("\n")}`;
}

export async function composeUpdate(rc: RuntimeConfig, lines: string[]): Promise<string> {
  try {
    const result = await runModel({
      role: "worker", config: rc, systemPrompt: SYSTEM_PROMPT, timeoutMs: 45_000,
      prompt: `Updates:\n${lines.join("\n")}\n\nWrite the message.`,
    });
    const text = result.isError ? "" : result.text.trim();
    return text.length > 0 ? text : plainUpdate(lines);
  } catch {
    return plainUpdate(lines);
  }
}
