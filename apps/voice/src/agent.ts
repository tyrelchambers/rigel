// The voice Agent: instructions, tools, and the per-turn hook that carries both
// context injection and the spoken-confirmation gate.
import { llm, voice } from "@livekit/agents";
import { ACTION_KINDS, isVoiceConfirmable, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { voiceSystemPrompt } from "@rigel/server/src/systemPrompt";
import { z } from "zod";
import { matchConfirmPhrase } from "./confirmPhrase.js";
import { decideMutationRoute, isPendingLive } from "./mutationFlow.js";
import { desktopPresent, publishJson, type PublishRoom } from "./publish.js";
import { runRead } from "./readTool.js";
import type { ServerClient } from "./serverClient.js";
import type { SessionState } from "./state.js";

export const CONTEXT_HEADING = "[Live cluster context]";

export const CONFIRM_PROMPT = "Say confirm to run it, or cancel.";

export function buildAgent(state: SessionState, server: ServerClient, room: PublishRoom): voice.Agent {
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
                // Handed back to the model as tool output rather than thrown,
                // so nothing else ever sees it: without this line a failed read
                // leaves no trace outside the model's own context.
                console.error(`readCluster ${args.verb} failed:`, err);
                return String(err);
              }
            },
          }),
          proposeMutation: llm.tool({
            description:
              "Propose a cluster change as a Rigel action object ({label, kind, name, namespace, ...}). Never claims to run anything; follow the returned instruction verbatim.",
            parameters: z.object({ action: z.record(z.string(), z.unknown()) }),
            execute: async ({ action }, opts) => {
              const a = action as unknown as SuggestedAction;
              if (!a || typeof a.kind !== "string" || !(ACTION_KINDS as readonly string[]).includes(a.kind)) {
                return "Refused: unknown action kind. Use one of Rigel's chat action kinds.";
              }
              const id = opts.toolCallId;

              // Three click-required kinds cannot be previewed at all:
              // /api/action short-circuits purge to {purge,name,namespace} with
              // no command field, and throws outright for applyManifest and
              // proposeRepoFix, which route to /api/apply and
              // /api/git/propose-fix. Skipping the preview is safe because the
              // kind table already pins these to click and classifyTier can
              // only agree.
              if (!isVoiceConfirmable(a)) {
                if (!desktopPresent(room)) {
                  return "Refused: that change is irreversible and there is no desktop session to confirm it on. Tell the user this in one sentence.";
                }
                state.awaitingClick.set(id, a.label);
                await publishJson(room, "rigel.action", { id, tier: "click", action: a, command: null });
                return "Sent to the desktop popover. Tell the user this change is irreversible, so it needs a tap on the desktop button to run.";
              }

              let argv: string[];
              try {
                argv = await server.previewAction(a, state.activeContext);
              } catch (err) {
                return `Refused: the app could not build that command (${String(err)}).`;
              }
              if (!Array.isArray(argv) || argv.length === 0) {
                return "Refused: the app could not build that command.";
              }
              const command = argv.join(" ");
              const decided = decideMutationRoute(a, command, desktopPresent(room));
              if (decided.route === "refuse") {
                return `Refused: ${decided.reason}. Tell the user this in one sentence.`;
              }
              if (decided.route === "click") {
                state.awaitingClick.set(id, a.label);
                await publishJson(room, "rigel.action", { id, tier: "click", action: a, command });
                return "Sent to the desktop popover. Tell the user this change is irreversible, so it needs a tap on the desktop button to run.";
              }

              state.pending = { id, action: a, command, armedAt: Date.now() };
              // The slot opens now so a confirmation spoken over the readback
              // still lands, but the TTL clock is restarted once the readback
              // has actually played: reading a long kubectl command aloud would
              // otherwise eat most of the window. addDoneCallback rather than
              // speechHandle.waitForPlayout(), which throws
              // SpeechHandleCircularWaitError when awaited from inside the tool
              // that owns the handle.
              //
              // Never call opts.ctx.disallowInterruptions() here. A
              // non-interruptible readback makes agent_activity drop user input
              // before onUserTurnCompleted runs, so the confirm word would be
              // unhearable.
              opts.ctx.speechHandle.addDoneCallback(() => {
                if (state.pending?.id === id) state.pending.armedAt = Date.now();
              });
              await publishJson(room, "rigel.action", { id, tier: "voice", action: a, command });
              return `Proposed and awaiting a spoken confirmation. Read this command back to the user verbatim: ${command}. Then say exactly: ${CONFIRM_PROMPT}`;
            },
          }),
        },
      });
    }

    override async onUserTurnCompleted(_chatCtx: llm.ChatContext, newMessage: llm.ChatMessage): Promise<void> {
      const pending = state.pending;
      // Applied to the FINAL transcript of the NEXT user turn only. Any
      // utterance that is not a confirmation clears the slot, so a stale
      // proposal can never be executed by a later turn.
      state.pending = null;
      if (isPendingLive(pending, Date.now())) {
        const verdict = matchConfirmPhrase(newMessage.textContent ?? "");
        if (verdict === "confirm") {
          let spoken: string;
          try {
            const res = await server.runAction(pending.action, state.activeContext);
            const ok = res.code === 0;
            const firstErr = res.stderr.split("\n").find(Boolean) ?? "unknown error";
            await publishJson(room, "rigel.action.result", { id: pending.id, ok, summary: ok ? "ran" : firstErr });
            spoken = ok ? `Done. ${pending.action.label} completed.` : `That failed: ${firstErr}.`;
          } catch (err) {
            await publishJson(room, "rigel.action.result", { id: pending.id, ok: false, summary: String(err) });
            spoken = "That failed to reach the app. Nothing was changed.";
          }
          this.session.say(spoken);
          throw new voice.StopResponse();
        }
        if (verdict === "cancel") {
          await publishJson(room, "rigel.action.result", { id: pending.id, ok: false, summary: "cancelled" });
          this.session.say("Cancelled. Nothing was changed.");
          throw new voice.StopResponse();
        }
      }
      if (state.contextLines.length === 0) return;
      newMessage.content.push(`${CONTEXT_HEADING}\n${state.contextLines.join("\n")}`);
      state.contextLines = [];
    }
  })();
}

/**
 * The desktop publishes rigel.state only after the room is up, so the prompt
 * baked in at construction almost always says no context is selected. Re-issue
 * it whenever the context moves, or the model hedges about which cluster it is
 * on while the tools silently read the right one.
 */
export async function refreshInstructions(agent: voice.Agent, state: SessionState): Promise<void> {
  await agent.updateInstructions(voiceSystemPrompt(state.activeContext));
}
