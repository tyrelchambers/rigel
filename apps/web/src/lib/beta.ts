import type { EntitlementPayload } from "./desktop";

export const FREE_PUBLIC_BETA = true;

export const BETA_ENTITLEMENT: EntitlementPayload = {
  plan: "pro",
  audits: ["reliability", "security", "performance", "ha"],
  cloudConnect: true,
  agentAutonomy: true,
  fetchedAt: new Date(0).toISOString(),
  beta: true,
};
