import { DEFAULT_AUDIT_ENTITLEMENT, type AuditEntitlement } from "@rigel/k8s";

export function useAuditEntitlement(): AuditEntitlement {
  return DEFAULT_AUDIT_ENTITLEMENT;
}
