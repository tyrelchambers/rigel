// Dispatches a chat turn to the active agent's runner. Claude and Codex have
// real runners; any other (coming-soon) active agent yields a single "not
// available" event.
import { runClaude, type ChatEvent, type RunClaudeOpts } from "./claudeBridge";
import { runCodex } from "./codexBridge";
import { runGemini } from "./geminiBridge";
import { runOpencode } from "./opencodeBridge";
import { getAgent } from "./agentRegistry";
import { readAgentsConfig } from "./agentConfig";
import { enabledSshHosts } from "./ssh";

export async function* runAgent(
  prompt: string,
  context: string | null,
  signal?: AbortSignal,
  opts?: RunClaudeOpts,
): AsyncGenerator<ChatEvent> {
  const { activeAgentId } = await readAgentsConfig(context);
  const agent = getAgent(activeAgentId);
  const runOpts: RunClaudeOpts = { ...opts, sshHosts: await enabledSshHosts() };

  if (agent?.id === "claude") {
    yield* runClaude(prompt, context, signal, runOpts);
    return;
  }

  if (agent?.id === "codex") {
    yield* runCodex(prompt, context, signal, runOpts);
    return;
  }

  if (agent?.id === "gemini") {
    yield* runGemini(prompt, context, signal, runOpts);
    return;
  }

  if (agent?.id === "opencode") {
    yield* runOpencode(prompt, context, signal, runOpts);
    return;
  }

  yield {
    type: "error",
    text: `The "${agent?.label ?? activeAgentId}" agent isn't available yet. Open Settings → Agents and connect an available agent.`,
  };
}
