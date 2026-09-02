export type FailoverProvider = "digitalocean";

export const DEFAULT_FAILOVER_REGION = "tor1";
export const DEFAULT_FAILOVER_NODE_SIZE = "s-4vcpu-8gb";
export const DEFAULT_FAILOVER_NODE_COUNT = 2;

export type FailoverSelection =
  | { kind: "app"; name: string; namespace: string }
  | { kind: "namespace"; namespace: string }
  | { kind: "workloads"; items: Array<{ kind: string; namespace: string; name: string }> };

export interface FailoverDestination {
  provider: FailoverProvider;
  token: string;
  spacesKey: string;
  spacesSecret: string;
  region: string;
  nodeSize: string;
  nodeCount: number;
  lastSelection?: FailoverSelection;
}

/** What the Settings panel is allowed to see. Secret values never appear. */
export interface FailoverDestinationView {
  configured: boolean;
  provider: FailoverProvider;
  tokenSet: boolean;
  spacesKeySet: boolean;
  spacesSecretSet: boolean;
  region: string;
  nodeSize: string;
  nodeCount: number;
  lastSelection?: FailoverSelection;
}

export interface FailoverDestinationPatch {
  token?: string;
  spacesKey?: string;
  spacesSecret?: string;
  region?: string;
  nodeSize?: string;
  nodeCount?: number;
}
