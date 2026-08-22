// The worker's only line to the local Rigel server: bootstrap config, and the
// SAME /api/action route the ConfirmSheet uses (identical execution + guards).
import type { SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import type { RepoLink } from "@rigel/k8s/src/gitSources";
import type { RepoFixResult } from "@rigel/k8s/src/repoFix";

/** What the propose-fix route answers with, plus what adoption committed. */
export interface ProposeFixResult extends RepoFixResult {
  /** kind/name of every resource an adoption pull request carries. */
  included?: string[];
}

export interface AgentConfig {
  url: string;
  token: string;
  model: string;
  sttModel: string;
  ttsModel: string;
  apiKey: string;
  apiSecret: string;
  openrouterApiKey: string;
}

/**
 * The server answers /api/voice/agent-config with 409 (never thrown as a
 * generic HTTP error) when voice is reachable but not configured: missing a
 * required field in the rigel-user-config Secret, not a transient failure.
 * `missing` names which fields, straight from the response body, so a caller
 * can log something more useful than a bare status code.
 */
export interface ActionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class VoiceNotConfiguredError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`voice is not configured${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}`);
    this.name = "VoiceNotConfiguredError";
    this.missing = missing;
  }
}

/** The workload a Git-link question is about; kind defaults to a Deployment. */
export interface WorkloadRef {
  kind?: string;
  name: string;
  namespace?: string;
}

/** One resource belonging to an app, as the discovery engine reports it. */
export interface RelatedResource {
  kind: string;
  name: string;
  namespace: string;
}

export interface RelatedResources {
  name: string;
  namespace: string;
  resources: RelatedResource[];
  helmRelease?: string;
  blockedReason?: string;
}

export interface ServerClient {
  agentConfig(): Promise<AgentConfig>;
  /** Every resource belonging to one app, found the way the app itself was
   *  labelled rather than by a selector the model guessed at. */
  relatedResources(name: string, namespace: string, context: string | null): Promise<RelatedResources>;
  /** Records a request no action kind expresses, so the gap is visible. */
  reportUnsupported(request: string, context: string | null): Promise<void>;
  /** Whether a workload is deployed from a Git source, and which one. */
  repoLink(workload: WorkloadRef, context: string | null): Promise<{ linked: boolean; link: RepoLink | null }>;
  /** Opens a pull request for the change the action describes. Changes no
   *  cluster state, so the agent may reach this on the operator's instruction
   *  without a click; the server stamps the PR `rigel:voice`. */
  proposeFix(action: SuggestedAction, context: string | null): Promise<ProposeFixResult>;
  previewAction(action: SuggestedAction, context: string | null): Promise<string[]>;
  /** Runs a change the operator asked for. Reachable ONLY for kinds
   *  isAutoRunnable admits: destructive work goes to the desktop's confirm
   *  sheet instead, and no spoken word reaches this. The server stamps the
   *  ledger entry `source: "voice"`, so it is attributable afterwards. */
  runAction(action: SuggestedAction, context: string | null): Promise<ActionResult>;
}

/** The server's own reason for a refusal, so the agent can speak it. */
async function errorMessage(res: { status: number; json(): Promise<unknown> }, what: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${what} failed: ${res.status}`;
}

export function createServerClient(
  base: string,
  sessionSecret: string,
  workerToken: string,
  fetchFn: typeof fetch = fetch,
): ServerClient {
  const headers = (context?: string | null): Record<string, string> => ({
    "content-type": "application/json",
    "x-rigel-session": sessionSecret,
    "x-rigel-voice-worker": workerToken,
    ...(context ? { "X-Rigel-Context": context } : {}),
  });
  return {
    async agentConfig() {
      const res = await fetchFn(`${base}/api/voice/agent-config`, { headers: headers() });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { missing?: string[] };
        throw new VoiceNotConfiguredError(body.missing ?? []);
      }
      if (!res.ok) throw new Error(`agent-config failed: ${res.status}`);
      return (await res.json()) as AgentConfig;
    },
    async relatedResources(name, namespace, context) {
      const query = new URLSearchParams({ name, namespace });
      const res = await fetchFn(`${base}/api/discover?${query}`, { headers: headers(context) });
      if (!res.ok) throw new Error(await errorMessage(res, "discover"));
      return (await res.json()) as RelatedResources;
    },
    async reportUnsupported(request, context) {
      const res = await fetchFn(`${base}/api/ai/unsupported`, {
        method: "POST",
        headers: headers(context),
        body: JSON.stringify({ request }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, "reporting the request"));
    },
    async repoLink(workload, context) {
      const query = new URLSearchParams({
        namespace: workload.namespace ?? "default",
        deployment: workload.name,
        kind: workload.kind ?? "deployment",
      });
      const res = await fetchFn(`${base}/api/git/link?${query}`, { headers: headers(context) });
      if (!res.ok) throw new Error(await errorMessage(res, "git link"));
      return (await res.json()) as { linked: boolean; link: RepoLink | null };
    },
    async proposeFix(action, context) {
      const res = await fetchFn(`${base}/api/git/propose-fix`, {
        method: "POST",
        headers: headers(context),
        body: JSON.stringify({
          source: action.source,
          title: action.title,
          ...(action.body ? { body: action.body } : {}),
          name: action.name,
          ...(action.namespace ? { namespace: action.namespace } : {}),
          ...(action.resourceKind ? { resourceKind: action.resourceKind } : {}),
          // Adoption carries no edit: the server reads the cluster and builds
          // every file, which is the whole point of it.
          ...(action.kind === "adoptWorkload" ? { adopt: true } : { edit: action.edit }),
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, "propose-fix"));
      return (await res.json()) as ProposeFixResult;
    },
    async previewAction(action, context) {
      const res = await fetchFn(`${base}/api/action?preview=1`, {
        method: "POST",
        headers: headers(context),
        body: JSON.stringify(action),
      });
      if (!res.ok) throw new Error(`action preview failed: ${res.status}`);
      return ((await res.json()) as { command: string[] }).command;
    },
    async runAction(action, context) {
      const res = await fetchFn(`${base}/api/action`, {
        method: "POST",
        headers: headers(context),
        body: JSON.stringify(action),
      });
      if (!res.ok) throw new Error(`action failed: ${res.status}`);
      return (await res.json()) as ActionResult;
    },
  };
}
