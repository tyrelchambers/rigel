import { descriptorFor } from "./descriptors";

/** True when the CLI/kubectl stderr indicates the user must re-login for `provider`. */
export function detectAuthExpiry(provider: string, stderr: string): boolean {
  const d = descriptorFor(provider);
  if (!d) return false;
  const s = stderr.toLowerCase();
  return d.authErrorPatterns.some((p) => s.includes(p.toLowerCase()));
}
