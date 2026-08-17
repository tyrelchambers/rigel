// The worker's only line to the local Rigel server: bootstrap config, and the
// SAME /api/action route the ConfirmSheet uses (identical execution + guards).
import type { SuggestedAction } from "@rigel/k8s/src/actionBlocks";

export interface AgentConfig {
  url: string;
  token: string;
  model: string;
  apiKey: string;
  apiSecret: string;
  openrouterApiKey: string;
  deepgramApiKey: string;
  cartesiaApiKey: string;
}

export interface ActionResult {
  code: number;
  stdout: string;
  stderr: string;
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
