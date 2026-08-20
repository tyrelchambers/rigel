// The voice Agent: instructions, tools, and the per-turn hook that carries both
// context injection and the spoken-confirmation gate.
import { llm, voice } from "@livekit/agents";
import { ACTION_KINDS, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { voiceSystemPrompt } from "@rigel/server/src/systemPrompt";
import { z } from "zod";
import { decideMutationRoute } from "./mutationFlow.js";
import { desktopPresent, publishJson, type PublishRoom } from "./publish.js";
import { runRead } from "./readTool.js";
import type { ServerClient } from "./serverClient.js";
import type { SessionState } from "./state.js";

export const CONTEXT_HEADING = "[Live cluster context]";

/** Kinds /api/action refuses to preview; they carry no command string. */
const UNPREVIEWABLE_KINDS = new Set(["purge", "applyManifest", "proposeRepoFix"]);
const PREVIEWABLE = (a: SuggestedAction) => !UNPREVIEWABLE_KINDS.has(a.kind);

export const SENT_TO_DESKTOP =
  "Sent to the desktop popover. Tell the user it is waiting there for them to review and run it. Never say you have run it, and never ask them to confirm out loud: a spoken word cannot run a change.";

export const NO_DESKTOP =
  "Refused: every change needs a tap in the desktop app, and no desktop session is connected. Tell the user this in one sentence.";

/**
 * The refusal a wrong `kind` gets. It names the escape hatch and lists the
 * kinds, because the model that hit this in the field invented `patch` twice
 * and had nothing in the old message to correct toward.
 */
export function unknownKindRefusal(kind: unknown): string {
  const named = typeof kind === "string" && kind ? ` "${kind}"` : "";
  return [
    `Refused: unknown action kind${named}.`,
    'Metadata edits are the kinds "annotate" and "label" (annotations/labels object; a null value removes a key).',
    'Anything else the typed kinds do not model goes through kind "command" with the literal kubectl arguments in args, e.g. {"kind":"command","label":"...","args":["patch","deployment/web","-n","default","--type=merge","-p","{...}"]}.',
    `Valid kinds: ${ACTION_KINDS.join(", ")}.`,
    "Retry now with a valid kind rather than telling the user it cannot be done.",
  ].join(" ");
}

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
                return unknownKindRefusal(a?.kind);
              }
              const id = opts.toolCallId;

              // purge, applyManifest and proposeRepoFix cannot be previewed at
              // all: /api/action short-circuits purge to {purge,name,namespace}
              // with no command field, and throws outright for the other two,
              // which route to /api/apply and /api/git/propose-fix. They go to
              // the desktop without a command string; the ConfirmSheet builds
              // its own preview there.
              if (!PREVIEWABLE(a)) {
                if (!desktopPresent(room)) return NO_DESKTOP;
                state.awaitingClick.set(id, a.label);
                await publishJson(room, "rigel.action", { id, action: a, command: null });
                return SENT_TO_DESKTOP;
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
              const decided = decideMutationRoute(command, desktopPresent(room));
              if (decided.route === "refuse") {
                return `Refused: ${decided.reason}. Tell the user this in one sentence.`;
              }
              state.awaitingClick.set(id, a.label);
              await publishJson(room, "rigel.action", { id, action: a, command });
              return SENT_TO_DESKTOP;
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

/**
 * The desktop publishes rigel.state only after the room is up, so the prompt
 * baked in at construction almost always says no context is selected. Re-issue
 * it whenever the context moves, or the model hedges about which cluster it is
 * on while the tools silently read the right one.
 */
export async function refreshInstructions(agent: voice.Agent, state: SessionState): Promise<void> {
  await agent.updateInstructions(voiceSystemPrompt(state.activeContext));
}
