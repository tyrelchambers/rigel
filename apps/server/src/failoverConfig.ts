import { FAILOVER_CONFIG_KEY } from "@rigel/k8s/src/userConfig";
import {
  applyFailoverPatch,
  maskFailoverDestination,
  parseFailoverDestination,
  serializeFailoverDestination,
  type FailoverDestination,
  type FailoverDestinationPatch,
  type FailoverDestinationView,
} from "@rigel/k8s/src/failover/destination";
import { readUserConfig, writeUserConfig, type ClusterConfigStatus } from "./clusterConfigStore";

export interface FailoverConfigRead extends FailoverDestinationView {
  cluster: ClusterConfigStatus;
}

export async function readFailoverDestination(context: string | null): Promise<FailoverDestination | null> {
  const read = await readUserConfig(context);
  return parseFailoverDestination(read.data[FAILOVER_CONFIG_KEY]);
}

export async function failoverConfigView(context: string | null): Promise<FailoverConfigRead> {
  const read = await readUserConfig(context);
  const dest = parseFailoverDestination(read.data[FAILOVER_CONFIG_KEY]);
  const { data: _data, ...cluster } = read;
  return { ...maskFailoverDestination(dest), cluster };
}

export function failoverPatchFromBody(body: unknown): FailoverDestinationPatch {
  if (!body || typeof body !== "object") return {};
  const o = body as Record<string, unknown>;
  const patch: FailoverDestinationPatch = {};
  if (typeof o.token === "string") patch.token = o.token;
  if (typeof o.spacesKey === "string") patch.spacesKey = o.spacesKey;
  if (typeof o.spacesSecret === "string") patch.spacesSecret = o.spacesSecret;
  if (typeof o.region === "string") patch.region = o.region;
  if (typeof o.nodeSize === "string") patch.nodeSize = o.nodeSize;
  if (typeof o.nodeCount === "number") patch.nodeCount = o.nodeCount;
  if (o.edge && typeof o.edge === "object") {
    const e = o.edge as { host?: unknown; backends?: unknown };
    const host = typeof e.host === "string" ? e.host.trim() : "";
    const backends = Array.isArray(e.backends)
      ? e.backends.flatMap((b) => {
          const r = (b ?? {}) as { name?: unknown; ip?: unknown };
          return typeof r.name === "string" && typeof r.ip === "string" && r.name && r.ip
            ? [{ name: r.name, ip: r.ip }]
            : [];
        })
      : [];
    if (host) patch.edge = { host, backends };
  }
  return patch;
}

export async function writeFailoverPatch(
  context: string | null,
  patch: FailoverDestinationPatch,
): Promise<FailoverConfigRead> {
  const current = await readFailoverDestination(context);
  const next = applyFailoverPatch(current, patch);
  if (!next) {
    throw new Error("DigitalOcean token and Spaces key pair are required");
  }
  await writeUserConfig(context, () => ({
    [FAILOVER_CONFIG_KEY]: serializeFailoverDestination(next),
  }));
  return failoverConfigView(context);
}
