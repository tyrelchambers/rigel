export interface CheckResult {
  cliInstalled: boolean;
  extraBinariesInstalled: boolean;
  authenticated: boolean;
  account?: string | null;
}

export type WizardStep = "needs-cli" | "needs-extra" | "needs-login" | "ready";

/** Decide the next wizard step from a provider check result. */
export function nextStepFromCheck(c: CheckResult): WizardStep {
  if (!c.cliInstalled) return "needs-cli";
  if (!c.extraBinariesInstalled) return "needs-extra";
  if (!c.authenticated) return "needs-login";
  return "ready";
}
