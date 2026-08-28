import type { CloudProvider } from "@rigel/cloud-connect/src/index";

export type ConnectTarget = CloudProvider | "import";

export interface Entitlement {
  allowed: boolean;
  reason?: string;
}

// MUST mirror the canonical shape in apps/api/src/entitlements.ts exactly —
// same field names + the precise audit union (not string[]). This is one of the
// four boundary copies of EntitlementPayload (signups → desktop billingClient →
// web desktop.ts → here); they are duplicated across package boundaries on
// purpose (like Account/Org), but their shapes must not drift.
export interface EntitlementPayload {
  plan: "free" | "pro";
  audits: ("reliability" | "security" | "performance" | "ha")[];
  cloudConnect: boolean;
  agentAutonomy: boolean;
  fetchedAt: string;
}

// The live entitlement, pushed from desktop main over the utilityProcess message
// channel (see index.ts). Defaults to null (free) until the first push.
let current: EntitlementPayload | null = null;
export function setEntitlement(e: EntitlementPayload | null): void { current = e; }

const BETA: EntitlementPayload = {
  plan: "pro",
  audits: ["reliability", "security", "performance", "ha"],
  cloudConnect: true,
  agentAutonomy: true,
  fetchedAt: new Date(0).toISOString(),
};

function live(): EntitlementPayload | null {
  return /^(1|true|yes|on)$/i.test(process.env.RIGEL_PAID_ENTITLEMENTS ?? "") ? current : BETA;
}

export function canConnect(target: ConnectTarget): Entitlement {
  if (target === "import") return { allowed: true }; // kubeconfig import is always free
  if (live()?.cloudConnect) return { allowed: true };
  return { allowed: false, reason: "Connecting a cloud provider requires Rigel Pro." };
}

export function canBeAutonomous(): boolean { return !!live()?.agentAutonomy; }

export function cloudEnabled(): boolean { return !!live()?.cloudConnect; }

export function unlockedAuditsEnv(): string { return (live()?.audits ?? []).join(","); }
