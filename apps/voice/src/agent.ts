// The voice Agent: instructions + tools + the per-turn hook (confirm-phrase
// interception arrives in Phase 3; context injection lives here now).
import { llm, voice } from "@livekit/agents";
import { z } from "zod";
import { voiceSystemPrompt } from "@rigel/server/src/systemPrompt";
import { runRead } from "./readTool.js";
import type { SessionState } from "./state.js";

export const CONTEXT_HEADING = "[Live cluster context]";

export function buildAgent(state: SessionState): voice.Agent {
  return new (class extends voice.Agent {
    constructor() {
      super({
        instructions: voiceSystemPrompt(state.activeContext),
        tools: {
          readCluster: llm.tool({
            description:
              "Read live Kubernetes state from the active cluster. verb is one of get, describe, logs, top, events.",
            parameters: z.object({
              verb: z.enum(["get", "describe", "logs", "top", "events"]),
              kind: z.string().optional(),
              name: z.string().optional(),
              namespace: z.string().optional(),
              container: z.string().optional(),
              tail: z.number().int().positive().optional(),
            }),
            execute: async (args) => {
              try {
                return await runRead(args, state.activeContext);
              } catch (err) {
                return String(err);
              }
            },
          }),
        },
      });
    }

    override async onUserTurnCompleted(_chatCtx: llm.ChatContext, newMessage: llm.ChatMessage): Promise<void> {
      if (state.contextLines.length === 0) return;
      newMessage.content.push(`${CONTEXT_HEADING}\n${state.contextLines.join("\n")}`);
      state.contextLines = [];
    }
  })();
}
