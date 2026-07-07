import type { ConversionResult } from "./types";

export interface ExplainedResource {
  kind: string;
  count: number;
  text: string;
}

export interface Explanation {
  summary: string;
  resources: ExplainedResource[];
}

const RESOURCE_TEXT: Record<string, string> = {
  Deployment: "Run your app containers and restart any that crash.",
  Service: "Give your apps stable in-cluster addresses so they can reach each other by name.",
  PersistentVolumeClaim: "Reserve durable storage so your data survives restarts and updates.",
  Secret: "Hold sensitive values like passwords and tokens, separate from your app config.",
  Ingress: "Route traffic from outside the cluster to your app at the hostname you set.",
};

const RESOURCE_ORDER = ["Deployment", "Service", "PersistentVolumeClaim", "Secret", "Ingress"];

export function explainConversion(result: ConversionResult): Explanation {
  const total = result.manifests.length;
  const apps = result.manifests.filter((m) => m.kind === "Deployment").length;

  const summary =
    total === 0
      ? ""
      : `Your Compose file becomes ${total} Kubernetes resource${total === 1 ? "" : "s"}: ${apps} app${
          apps === 1 ? "" : "s"
        } plus the networking and storage that keep them running.`;

  const counts = new Map<string, number>();
  for (const m of result.manifests) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);

  const resources: ExplainedResource[] = RESOURCE_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
    kind,
    count: counts.get(kind)!,
    text: RESOURCE_TEXT[kind]!,
  }));

  return { summary, resources };
}
