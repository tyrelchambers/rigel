import { type AuditEntitlement } from "@rigel/k8s";
import { useEntitlement } from "@/shell/useEntitlement";

// Maps the resolved entitlement payload to the audit gate. No bridge / not loaded
// yet → locked (the real gate — free tier unlocks nothing). A resolved payload
// exposes exactly the unlocked audit kinds.
export function useAuditEntitlement(): AuditEntitlement {
  const { payload } = useEntitlement();
  if (!payload) return { unlocked: [] };
  return { unlocked: payload.audits };
}
