import type { SuggestedAction } from "./action.js";
import { isPodReady, type Incident } from "./detector.js";

export const VERIFY_SETTLE_MS = 3 * 60_000;
export const VERIFY_DEADLINE_MS = 10 * 60_000;

export interface PendingVerification {
  atMs: number;
  fingerprint: string;
  incident: string;
  label: string;
  action: SuggestedAction;
  ownerUid?: string;
  readyBefore?: number;
  databasesDownBefore: string[];
}

export type VerifyResult = { status: "pending" } | { status: "verified" } | { status: "failed"; why: string };

export interface VerifyView {
  now: number;
  present: ReadonlySet<string>;
  incidents: Incident[];
  pods: Record<string, any>[];
  deps: Record<string, any>[];
}

function ownerUidOf(pod: Record<string, any> | undefined): string | undefined {
  return pod?.metadata?.ownerReferences?.find((o: Record<string, any>) => o.controller)?.uid;
}

function readyOwnedBy(pods: Record<string, any>[], uid: string): number {
  return pods.filter((p) => ownerUidOf(p) === uid && isPodReady(p)).length;
}

export function databasesDown(incidents: Incident[]): string[] {
  return incidents.filter((i) => i.incidentKind === "databaseNotReady").map((i) => `${i.namespace}/${i.name}`);
}

export function pendingVerification(
  action: SuggestedAction,
  ctx: { atMs: number; fingerprint: string; incident: string; incidents: Incident[]; pods: Record<string, any>[] },
): PendingVerification {
  const base: PendingVerification = {
    atMs: ctx.atMs, fingerprint: ctx.fingerprint, incident: ctx.incident, label: action.label, action,
    databasesDownBefore: databasesDown(ctx.incidents),
  };
  if (action.kind !== "deletePod") return base;
  const ns = action.namespace ?? "default";
  const ownerUid = ownerUidOf(ctx.pods.find((p) => p.metadata?.name === action.pod && (p.metadata?.namespace ?? "default") === ns));
  return ownerUid ? { ...base, ownerUid, readyBefore: readyOwnedBy(ctx.pods, ownerUid) } : base;
}

function targetProblem(p: PendingVerification, v: VerifyView): string | null {
  const a = p.action;
  const ns = a.namespace ?? "default";
  switch (a.kind) {
    case "restart":
    case "rollback":
    case "scale":
    case "setEnv": {
      const dep = v.deps.find((d) => d.metadata?.name === a.deployment && (d.metadata?.namespace ?? "default") === ns);
      if (!dep) return `${a.deployment} is gone`;
      const desired = dep.spec?.replicas ?? 1;
      const ready = dep.status?.readyReplicas ?? 0;
      return ready >= desired ? null : `${a.deployment} has ${ready} of ${desired} copies running`;
    }
    case "deletePod": {
      if (p.ownerUid !== undefined) {
        const ready = readyOwnedBy(v.pods, p.ownerUid);
        return ready >= (p.readyBefore ?? 0) ? null : `the replacement for ${a.pod} isn't up`;
      }
      const same = v.pods.find((x) => x.metadata?.name === a.pod && (x.metadata?.namespace ?? "default") === ns);
      return !same || isPodReady(same) ? null : `${a.pod} isn't up`;
    }
    case "repairDatabase":
      return v.incidents.some((i) => i.incidentKind === "databaseNotReady" && i.name === a.cluster && i.namespace === ns)
        ? `the ${a.cluster} database is still down`
        : null;
    default:
      return null;
  }
}

export function verifyFix(p: PendingVerification, v: VerifyView): VerifyResult {
  const elapsed = v.now - p.atMs;
  if (elapsed < VERIFY_SETTLE_MS) return { status: "pending" };
  const newlyDown = databasesDown(v.incidents).filter((d) => !p.databasesDownBefore.includes(d));
  if (newlyDown.length > 0) return { status: "failed", why: `the ${newlyDown.join(", ")} database went down after it` };
  const problem = targetProblem(p, v);
  if (!problem && !v.present.has(p.fingerprint)) return { status: "verified" };
  if (elapsed < VERIFY_DEADLINE_MS) return { status: "pending" };
  return { status: "failed", why: problem ?? "the problem is still there" };
}
