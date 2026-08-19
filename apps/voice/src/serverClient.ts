// The worker's only line to the local Rigel server: bootstrap config, and the
// SAME /api/action route the ConfirmSheet uses (identical execution + guards).
import type { SuggestedAction } from "@rigel/k8s/src/actionBlocks";

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

export interface ActionResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The server answers /api/voice/agent-config with 409 (never thrown as a
 * generic HTTP error) when voice is reachable but not configured: missing a
 * required field in the rigel-user-config Secret, not a transient failure.
 * `missing` names which fields, straight from the response body, so a caller
 * can log something more useful than a bare status code.
 */
export class VoiceNotConfiguredError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`voice is not configured${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}`);
    this.name = "VoiceNotConfiguredError";
    this.missing = missing;
  }
}

export interface ServerClient {
  agentConfig(): Promise<AgentConfig>;
  previewAction(action: SuggestedAction, context: string | null): Promise<string[]>;
  runAction(action: SuggestedAction, context: string | null): Promise<ActionResult>;
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
