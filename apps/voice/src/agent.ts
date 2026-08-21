// The voice Agent: instructions, tools, and the per-turn hook that carries
// context injection. Non-destructive changes the operator asks for run here;
// destructive ones are published for approval on the desktop. Nothing listens
// for a spoken word.
import { llm, voice } from "@livekit/agents";
import { ACTION_KINDS, isAutoRunnable, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
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
  "Sent to the desktop popover for approval, because this one is destructive. Tell the user it is waiting there for them to approve. Never say you have run it, and never ask them to confirm out loud: a spoken word cannot run anything.";

export const NO_DESKTOP =
  "Refused: this one is destructive and needs approval in the desktop app, and no desktop session is connected. Tell the user this in one sentence.";

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

/**
 * The refusal a proposeRepoFix missing its parts gets. Names the shape and the
 * tool that supplies the source, so the model can retry in the same turn.
 */
export const REPO_FIX_SHAPE_REFUSAL = [
  "Refused: a pull request needs source, title, name and edit.",
  "source is the source id checkGitLink returns for that workload, name is the workload, and edit is the change:",
  '{"op":"annotate","annotations":{...}}, {"op":"label","labels":{...}}, {"op":"setImage","container":"...","image":"..."} or {"op":"scale","replicas":N},',
  "with a null annotation or label value removing the key. Add resourceKind when the workload is not a Deployment.",
  "Retry with those rather than telling the user it cannot be done.",
].join(" ");

/** Whether an action carries everything /api/git/propose-fix needs. */
const isProposable = (a: SuggestedAction): boolean =>
  Boolean(a.source && a.title && a.name && a.edit);

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
          checkGitLink: llm.tool({
            description:
              "Whether a workload is deployed from a Git repository, and which one. Ask before proposing a change to a workload, and always before offering a pull request.",
            parameters: z.object({
              kind: z.string().optional(),
              name: z.string(),
              namespace: z.string().optional(),
            }),
            execute: async ({ kind, name, namespace }) => {
              try {
                const { linked, link } = await server.repoLink({ kind, name, namespace }, state.activeContext);
                if (!linked || !link) {
                  return `Not managed from Git: ${name} carries no Rigel source annotation, so there is no repository to open a pull request against. Say that in one sentence if the user asked for one, and change the cluster instead if they want it changed now.`;
                }
                return `Managed from Git: source ${link.source}, repository ${link.repo}, branch ${link.branch}, path ${link.path}. A change here belongs in a pull request, because the next sync overwrites anything patched on the cluster. Pass that source to proposeMutation with kind proposeRepoFix.`;
              } catch (err) {
                console.error(`checkGitLink ${name} failed:`, err);
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

              // A pull request changes no cluster state, lands on a branch, and
              // is read on GitHub before it merges, so the agent opens it on the
              // operator's instruction (see AUTO_RUNNABLE_KINDS). It is not a
              // kubectl command, so it never goes near /api/action.
              if (a.kind === "proposeRepoFix" && isAutoRunnable(a)) {
                if (!isProposable(a)) return REPO_FIX_SHAPE_REFUSAL;
                await publishJson(room, "rigel.action", { id, action: a, command: null, auto: true });
                try {
                  const res = await server.proposeFix(a, state.activeContext);
                  if (!res.ok) {
                    await publishJson(room, "rigel.action.result", { id, ok: false, summary: res.message ?? "failed" });
                    return `That failed: ${res.message ?? "the pull request could not be opened"}. Nothing was pushed. Tell the user in one sentence.`;
                  }
                  await publishJson(room, "rigel.action.result", {
                    id,
                    ok: true,
                    summary: `opened pull request #${res.number ?? 0}`,
                    prUrl: res.prUrl,
                  });
                  return `Done: pull request #${res.number ?? 0} is open at ${res.prUrl}. Tell the user the pull request is open, name the repository and the number, and say the URL; the link is in the popover and the change itself is on GitHub. Nothing was changed on the cluster.`;
                } catch (err) {
                  await publishJson(room, "rigel.action.result", { id, ok: false, summary: String(err) });
                  return `That failed: ${String(err)}. Nothing was pushed. Tell the user in one sentence.`;
                }
              }

              // purge, applyManifest and a downgraded proposeRepoFix cannot be
              // previewed at all: /api/action short-circuits purge to
              // {purge,name,namespace} with no command field, and throws outright
              // for the other two, which route to /api/apply and
              // /api/git/propose-fix. They go to
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
              const decided = decideMutationRoute(a, command, desktopPresent(room));
              if (decided.route === "refuse") {
                return `Refused: ${decided.reason}. Tell the user this in one sentence.`;
              }
              if (decided.route === "click") {
                state.awaitingClick.set(id, a.label);
                await publishJson(room, "rigel.action", { id, action: a, command });
                return SENT_TO_DESKTOP;
              }

              // The operator asked for a change that destroys nothing, so the
              // agent carries it out. The frame goes up first so the popover
              // shows what is running before the result lands, and the server
              // stamps the ledger `source: "voice"` either way.
              await publishJson(room, "rigel.action", { id, action: a, command, auto: true });
              try {
                const res = await server.runAction(a, state.activeContext);
                const ok = res.code === 0;
                const firstErr = res.stderr.split("\n").find(Boolean) ?? "unknown error";
                await publishJson(room, "rigel.action.result", { id, ok, summary: ok ? "ran" : firstErr });
                return ok
                  ? `Done: ${command} ran and completed. Tell the user in one short sentence what changed.`
                  : `That failed: ${firstErr}. Tell the user it failed and why, in one sentence.`;
              } catch (err) {
                await publishJson(room, "rigel.action.result", { id, ok: false, summary: String(err) });
                return "That failed to reach the app, so nothing changed. Tell the user in one sentence.";
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

/**
 * The desktop publishes rigel.state only after the room is up, so the prompt
 * baked in at construction almost always says no context is selected. Re-issue
 * it whenever the context moves, or the model hedges about which cluster it is
 * on while the tools silently read the right one.
 */
export async function refreshInstructions(agent: voice.Agent, state: SessionState): Promise<void> {
  await agent.updateInstructions(voiceSystemPrompt(state.activeContext));
}
