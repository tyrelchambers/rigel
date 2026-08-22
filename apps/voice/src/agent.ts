// The voice Agent: instructions, tools, and the per-turn hook that carries
// context injection. Non-destructive changes the operator asks for run here;
// destructive ones are published for approval on the desktop. Nothing listens
// for a spoken word.
import { llm, voice } from "@livekit/agents";
import { isAutoRunnable, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { actionSchema } from "@rigel/k8s/src/actionSchema";
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

export function buildAgent(state: SessionState, server: ServerClient, room: PublishRoom): voice.Agent {
  return new (class extends voice.Agent {
    constructor() {
      super({
        instructions: voiceSystemPrompt(state.activeContext),
        tools: {
          readCluster: llm.tool({
            description:
              "Read the active cluster with literal kubectl arguments, e.g. [\"get\",\"deployment\",\"web\",\"-n\",\"default\",\"-o\",\"yaml\"]. Anything that only reads is allowed; a mutation is refused. Batch several resources into one call rather than spending a turn on several.",
            parameters: z.object({
              args: z
                .array(z.string())
                .describe("kubectl arguments, without the binary and without --context"),
            }),
            execute: async ({ args }) => {
              try {
                return await runRead(args, state.activeContext);
              } catch (err) {
                // Handed back to the model as tool output rather than thrown,
                // so nothing else ever sees it: without this line a failed read
                // leaves no trace outside the model's own context.
                console.error(`readCluster ${args.join(" ")} failed:`, err);
                return String(err);
              }
            },
          }),
          // Rigel's own answers, as one tool with a variant per question, so
          // it grows by variants rather than by tools. The model improvising
          // kubectl is exactly where it fails: asked for everything belonging to
          // an app it invents a label selector, gets an empty list, and reports
          // that nothing is there.
          queryRigel: llm.tool({
            description:
              "Ask Rigel what it already knows. query \"related\" returns everything belonging to a workload: the Services that select its pods, the Ingresses routing to them, and what its pods read. Prefer this over inventing a label selector.",
            parameters: z.object({
              query: z.literal("related"),
              name: z.string().describe("the app or workload name"),
              namespace: z.string().optional(),
              kind: z.string().optional().describe("workload kind if not a Deployment"),
            }),
            execute: async ({ name, namespace, kind }) => {
              try {
                const found = await server.relatedResources(name, namespace ?? "default", state.activeContext, kind);
                if (found.resources.length === 0) {
                  return `No resources found for ${name} in namespace ${found.namespace}. Check the name with a listing read before telling the user there is nothing there.`;
                }
                const listed = found.resources.map((r) => `${r.kind}/${r.name}`).join(", ");
                const helm = found.helmRelease ? ` It is a Helm release (${found.helmRelease}).` : "";
                return `${found.resources.length} resources belong to ${name} in ${found.namespace}: ${listed}.${helm} Say the count and the kinds; name individual resources only if asked.`;
              } catch (err) {
                console.error(`queryRigel related ${name} failed:`, err);
                return String(err);
              }
            },
          }),
          // The escape hatch that makes giving up cheaper than smuggling. The
          // model used to approximate an unsupported request with a valid but
          // meaningless action, which reached the operator as a refusal about
          // Rigel's internals rather than an answer about their cluster.
          reportUnsupported: llm.tool({
            description:
              "Say that a request is something Rigel cannot do. Use it whenever no action expresses what was asked, instead of approximating with a different action.",
            parameters: z.object({
              request: z.string().describe("what the operator asked for, in one sentence"),
            }),
            execute: async ({ request }) => {
              try {
                await server.reportUnsupported(request, state.activeContext);
              } catch (err) {
                // Recording is the lesser half: the operator still needs the
                // answer, so a ledger that refuses the write does not turn into
                // silence on the call.
                console.error("recording an unsupported request failed:", err);
              }
              return "Recorded. Tell the user in one sentence that Rigel cannot do that yet, name the nearest thing it can do, and do not attempt it another way.";
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
                return `Managed from Git: source ${link.source}, repository ${link.repo}, branch ${link.branch}, path ${link.path}. A change here belongs in a pull request, because the next sync overwrites anything patched on the cluster. To change a manifest the repository already has, call proposeMutation with kind proposeRepoFix and "source":"${link.source}". To ADD manifests it does not have yet, so the app can be redeployed from Git, use kind adoptWorkload with the same source.`;
              } catch (err) {
                console.error(`checkGitLink ${name} failed:`, err);
                return String(err);
              }
            },
          }),
          proposeMutation: llm.tool({
            description:
              "Propose a cluster change as a Rigel action. Never claims to run anything; follow the returned instruction verbatim.",
            // The SDK parses this before execute runs, so a wrong kind comes
            // back naming every valid kind and a wrong field comes back naming
            // that field. Nothing below has to check the shape.
            //
            // The preprocess is for one specific failure, seen four times in a
            // row in the field: a model that sends the nested object as a JSON
            // STRING. The refusal it gets back then says "expected object,
            // received string", which names nothing about the fields, so it has
            // no way to converge and eventually reports a working capability as
            // unsupported. Parsing the string is a transport repair, not a
            // loosening: what comes out is checked by exactly the same schema.
            parameters: z.object({
              action: z.preprocess((value) => {
                if (typeof value !== "string") return value;
                try {
                  return JSON.parse(value);
                } catch {
                  return value;
                }
              }, actionSchema),
            }),
            execute: async ({ action }, opts) => {
              const a = action as SuggestedAction;
              const id = opts.toolCallId;

              // A pull request changes no cluster state, lands on a branch, and
              // is read on GitHub before it merges, so the agent opens it on the
              // operator's instruction (see AUTO_RUNNABLE_KINDS). It is not a
              // kubectl command, so it never goes near /api/action.
              // Both PR kinds take the same route: they change no cluster
              // state, land on a branch, and are read on GitHub before merging.
              if ((a.kind === "proposeRepoFix" || a.kind === "adoptWorkload") && isAutoRunnable(a)) {
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
                    repoSlug: res.repoSlug,
                  });
                  const carried =
                    res.included && res.included.length > 0
                      ? ` It carries ${res.included.length} resources: ${res.included.join(", ")}.`
                      : "";
                  return `Done: pull request #${res.number ?? 0} is open at ${res.prUrl}.${carried} Tell the user the pull request is open, name the repository and the number, say the URL, and say how many resources it covers; the link is in the popover and the change itself is on GitHub. Nothing was changed on the cluster.`;
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
