export type AuditKind = "reliability" | "security" | "performance" | "ha";

export const ALL_AUDIT_KINDS: AuditKind[] = ["reliability", "security", "performance", "ha"];

export interface AuditEntitlement {
  unlocked: AuditKind[];
}

export interface AuditGate {
  allowed: boolean;
  reason?: string;
}

export function canRunAudit(kind: AuditKind, entitlement: AuditEntitlement): AuditGate {
  if (entitlement.unlocked.includes(kind)) return { allowed: true };
  return { allowed: false, reason: `The ${kind} audit is a premium skill. Upgrade to unlock it.` };
}

export const DEFAULT_AUDIT_ENTITLEMENT: AuditEntitlement = { unlocked: [...ALL_AUDIT_KINDS] };

export function parseUnlockedAudits(raw: string | undefined | null): AuditEntitlement {
  if (!raw || raw.trim() === "") return { unlocked: [...ALL_AUDIT_KINDS] };
  const unlocked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AuditKind => (ALL_AUDIT_KINDS as string[]).includes(s));
  return { unlocked };
}
