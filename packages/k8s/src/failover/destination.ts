import {
  DEFAULT_FAILOVER_NODE_COUNT,
  DEFAULT_FAILOVER_NODE_SIZE,
  DEFAULT_FAILOVER_REGION,
  type FailoverDestination,
  type FailoverDestinationPatch,
  type FailoverDestinationView,
  type FailoverSelection,
} from "./types";

export {
  DEFAULT_FAILOVER_NODE_COUNT,
  DEFAULT_FAILOVER_NODE_SIZE,
  DEFAULT_FAILOVER_REGION,
  type FailoverDestination,
  type FailoverDestinationPatch,
  type FailoverDestinationView,
  type FailoverProvider,
  type FailoverSelection,
} from "./types";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseEdge(value: unknown): import("./types").FailoverEdge | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const host = text(o.host);
  if (!host) return undefined;
  const backends = Array.isArray(o.backends)
    ? o.backends.flatMap((b) => {
        if (!b || typeof b !== "object") return [];
        const r = b as Record<string, unknown>;
        const name = text(r.name);
        const ip = text(r.ip);
        return name && ip ? [{ name, ip }] : [];
      })
    : [];
  return { host, backends };
}

function parseSelection(value: unknown): FailoverSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (o.kind === "app") {
    const name = text(o.name);
    const namespace = text(o.namespace);
    return name && namespace ? { kind: "app", name, namespace } : undefined;
  }
  if (o.kind === "namespace") {
    const namespace = text(o.namespace);
    return namespace ? { kind: "namespace", namespace } : undefined;
  }
  if (o.kind === "workloads" && Array.isArray(o.items)) {
    const items = o.items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const r = item as Record<string, unknown>;
      const kind = text(r.kind);
      const namespace = text(r.namespace);
      const name = text(r.name);
      return kind && namespace && name ? [{ kind, namespace, name }] : [];
    });
    return items.length > 0 ? { kind: "workloads", items } : undefined;
  }
  return undefined;
}

/** Blank or unreadable JSON is "not configured", not an error. */
export function parseFailoverDestination(blob: string): FailoverDestination | null {
  const trimmed = blob.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.provider !== "digitalocean") return null;
  const token = text(o.token);
  const spacesKey = text(o.spacesKey);
  const spacesSecret = text(o.spacesSecret);
  if (!token || !spacesKey || !spacesSecret) return null;
  const nodeCountRaw = o.nodeCount;
  const nodeCount =
    typeof nodeCountRaw === "number" && Number.isInteger(nodeCountRaw) && nodeCountRaw >= 1
      ? nodeCountRaw
      : DEFAULT_FAILOVER_NODE_COUNT;
  const dest: FailoverDestination = {
    provider: "digitalocean",
    token,
    spacesKey,
    spacesSecret,
    region: text(o.region) ?? DEFAULT_FAILOVER_REGION,
    nodeSize: text(o.nodeSize) ?? DEFAULT_FAILOVER_NODE_SIZE,
    nodeCount,
  };
  const edge = parseEdge(o.edge);
  if (edge) dest.edge = edge;
  const lastSelection = parseSelection(o.lastSelection);
  if (lastSelection) dest.lastSelection = lastSelection;
  return dest;
}

export function serializeFailoverDestination(dest: FailoverDestination): string {
  return JSON.stringify(dest);
}

export function maskFailoverDestination(dest: FailoverDestination | null): FailoverDestinationView {
  if (!dest) {
    return {
      configured: false,
      provider: "digitalocean",
      tokenSet: false,
      spacesKeySet: false,
      spacesSecretSet: false,
      region: DEFAULT_FAILOVER_REGION,
      nodeSize: DEFAULT_FAILOVER_NODE_SIZE,
      nodeCount: DEFAULT_FAILOVER_NODE_COUNT,
    };
  }
  return {
    configured: true,
    provider: dest.provider,
    tokenSet: true,
    spacesKeySet: true,
    spacesSecretSet: true,
    region: dest.region,
    nodeSize: dest.nodeSize,
    nodeCount: dest.nodeCount,
    ...(dest.edge ? { edge: dest.edge } : {}),
    ...(dest.lastSelection ? { lastSelection: dest.lastSelection } : {}),
  };
}

/** Merge a Settings patch onto the stored destination. Secret fields that are
 *  omitted keep their stored value; a first-time save still needs all three. */
export function applyFailoverPatch(
  current: FailoverDestination | null,
  patch: FailoverDestinationPatch,
): FailoverDestination | null {
  const token = text(patch.token) ?? current?.token;
  const spacesKey = text(patch.spacesKey) ?? current?.spacesKey;
  const spacesSecret = text(patch.spacesSecret) ?? current?.spacesSecret;
  if (!token || !spacesKey || !spacesSecret) return null;
  const nodeCount =
    typeof patch.nodeCount === "number" && Number.isInteger(patch.nodeCount) && patch.nodeCount >= 1
      ? patch.nodeCount
      : (current?.nodeCount ?? DEFAULT_FAILOVER_NODE_COUNT);
  return {
    provider: "digitalocean",
    token,
    spacesKey,
    spacesSecret,
    region: text(patch.region) ?? current?.region ?? DEFAULT_FAILOVER_REGION,
    nodeSize: text(patch.nodeSize) ?? current?.nodeSize ?? DEFAULT_FAILOVER_NODE_SIZE,
    nodeCount,
    ...(patch.edge ?? current?.edge ? { edge: patch.edge ?? current?.edge } : {}),
    ...(current?.lastSelection ? { lastSelection: current.lastSelection } : {}),
  };
}
