import type { ConversionResult, WarningFix } from "./types";

export interface ExplainedResource {
  kind: string;
  count: number;
  text: string;
}

export interface Explanation {
  summary: string;
  resources: ExplainedResource[];
  attention: string[];
}

const RESOURCE_TEXT: Record<string, string> = {
  Deployment: "Run your app containers and restart any that crash.",
  Service: "Give your apps stable in-cluster addresses so they can reach each other by name.",
  PersistentVolumeClaim: "Reserve durable storage so your data survives restarts and updates.",
  Secret: "Hold sensitive values like passwords and tokens, separate from your app config.",
  Ingress: "Route traffic from outside the cluster to your app at the hostname you set.",
};

const RESOURCE_ORDER = ["Deployment", "Service", "PersistentVolumeClaim", "Secret", "Ingress"];

const ATTENTION_TEXT: Record<WarningFix["option"], string> = {
  expose:
    "Your apps' ports are internal-only right now. Use a port's Fix (LoadBalancer or Ingress) to reach them from outside the cluster.",
  emitSecrets:
    "Some values look like passwords. Use Fix to have Rigel create a Secret to hold them, or create it yourself before applying.",
  bindMountsToPvc:
    "A folder from your machine (a bind mount) can't move to Kubernetes as-is. Use Fix to turn it into cluster storage.",
  addWaitInit: "Kubernetes starts everything at once. Use Fix to make dependents wait for what they need.",
};

const ATTENTION_ORDER: WarningFix["option"][] = ["expose", "emitSecrets", "bindMountsToPvc", "addWaitInit"];

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

  const fixOptions = new Set(
    result.warnings.map((w) => w.fix?.option).filter((o): o is WarningFix["option"] => !!o),
  );
  const attention = ATTENTION_ORDER.filter((option) => fixOptions.has(option)).map((option) => ATTENTION_TEXT[option]);

  return { summary, resources, attention };
}
