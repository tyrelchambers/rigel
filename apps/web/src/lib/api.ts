import { useMutation } from "@tanstack/react-query";

/**
 * ActionBlock mirrors the server-side ActionBlock interface and
 * the Swift SuggestedAction JSON contract (docs/parity/contracts.md § 1).
 */
export interface ActionBlock {
  kind: string;
  label?: string;
  name?: string;
  deployment?: string;
  pod?: string;
  node?: string;
  namespace?: string;
  replicas?: number;
  env?: Record<string, string>;
  container?: string;
  image?: string;
  requests?: string;
  limits?: string;
  resourceKind?: string;
  args?: string[];
  destructive?: boolean;
}

export interface ActionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PurgeResult {
  purge: true;
  name: string | null;
  namespace: string;
}

export type ActionResponse = ActionResult | PurgeResult;

/** Fetch the preview command string for an action without executing it. */
export async function fetchPreviewCommand(action: ActionBlock): Promise<string[]> {
  const res = await fetch("/api/action?preview=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  const data = (await res.json()) as { command: string[] };
  return data.command;
}

/** Execute a chat action-block mutation via the server's guarded route. */
async function executeAction(action: ActionBlock): Promise<ActionResponse> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<ActionResponse>;
}

/**
 * TanStack Query mutation hook for executing action-block mutations.
 * The caller is responsible for showing the ConfirmSheet first.
 */
export function useAction() {
  return useMutation<ActionResponse, Error, ActionBlock>({
    mutationFn: executeAction,
  });
}
