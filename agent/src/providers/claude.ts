import { runClaude } from "../claude.js";
import { errorResult, type ProviderBridge, type ProviderResult, type RunModelInput } from "./types.js";

/**
 * Claude bridge — wraps the existing, working `runClaude` (agent/src/claude.ts).
 * Read-only investigation stays enforced with --allowedTools; structured verdicts
 * use --json-schema; sessions resume via --resume. Auth is the subscription token
 * (CLAUDE_CODE_OAUTH_TOKEN) or ANTHROPIC_API_KEY, injected by the Deployment env.
 */
export const claudeBridge: ProviderBridge = {
  id: "claude",

  authEnv(): Record<string, string> | null {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (token && token.trim()) return { CLAUDE_CODE_OAUTH_TOKEN: token };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && apiKey.trim()) return { ANTHROPIC_API_KEY: apiKey };
    return null;
  },

  async run(input: RunModelInput): Promise<ProviderResult> {
    try {
      const r = await runClaude({
        model: input.model,
        prompt: input.prompt,
        appendSystemPrompt: input.systemPrompt,
        allowedTools: input.allowedReads,
        jsonSchema: input.structuredSchema,
        resumeSessionId: input.resumeSessionId,
        timeoutMs: input.timeoutMs,
      });
      return {
        text: r.text,
        costUsd: r.costUsd,
        isError: r.isError,
        sessionId: r.sessionId,
        structuredOutput: r.structuredOutput,
      };
    } catch (e) {
      return errorResult(String(e instanceof Error ? e.message : e));
    }
  },
};
