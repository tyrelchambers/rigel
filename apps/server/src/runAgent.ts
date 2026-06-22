// Dispatches a chat turn to the active agent's runner. Claude and Codex have
// real runners; any other (coming-soon) active agent yields a single "not
// available" event.
import { runClaude, type ChatEvent, type RunClaudeOpts } from "./claudeBridge";
import { runCodex } from "./codexBridge";
import { getAgent } from "./agentRegistry";
import { readAgentsConfig } from "./agentConfig";

export async function* runAgent(
  prompt: string,
  context: string | null,
  signal?: AbortSignal,
  opts?: RunClaudeOpts,
): AsyncGenerator<ChatEvent> {
  const { activeAgentId } = await readAgentsConfig();
  const agent = getAgent(activeAgentId);

  if (agent?.id === "claude") {
    yield* runClaude(prompt, context, signal, opts);
    return;
  }

  if (agent?.id === "codex") {
    yield* runCodex(prompt, context, signal, opts);
    return;
  }

  yield {
    type: "error",
    text: `The "${agent?.label ?? activeAgentId}" agent isn't available yet. Open Settings → Agents and connect an available agent.`,
  };
}
