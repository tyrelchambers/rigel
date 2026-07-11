// Runs `kubectl auth can-i` impersonating a subject, for the RBAC panel's
// inline access test. Read-only (can-i is a non-mutating verb), so it uses the
// plain kubectl runner and needs no confirm gate.

export interface Subject { kind?: string; name?: string; namespace?: string }
export interface CanICheck { verb: string; resource: string; apiGroup?: string; namespace?: string }
export interface CanIResult extends CanICheck { allowed: boolean | null }

type Run = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export function impersonationArgs(subject: Subject): string[] {
  const kind = subject.kind ?? "ServiceAccount";
  const name = subject.name ?? "";
  if (kind === "ServiceAccount") {
    return [`--as=system:serviceaccount:${subject.namespace ?? "default"}:${name}`];
  }
  if (kind === "Group") {
    // kubectl requires a --as user alongside --as-group; a synthetic username in
    // the target group yields the group's effective access.
    return ["--as=rigel:can-i-probe", `--as-group=${name}`];
  }
  return [`--as=${name}`];
}

export function resourceArg(check: CanICheck): string {
  const g = check.apiGroup;
  if (g && g !== "" && g !== "*") return `${check.resource}.${g}`;
  return check.resource;
}

function parseAllowed(stdout: string): boolean | null {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last === "yes") return true;
  if (last === "no") return false;
  return null;
}

export async function runCanI(
  subject: Subject,
  checks: CanICheck[],
  run: Run,
): Promise<{ results: CanIResult[]; note?: string }> {
  const asArgs = impersonationArgs(subject);
  const results: CanIResult[] = [];
  let note: string | undefined;
  for (const check of checks) {
    const args = ["auth", "can-i", check.verb, resourceArg(check), ...asArgs];
    if (check.namespace) args.push("-n", check.namespace);
    const r = await run(args);
    const allowed = parseAllowed(r.stdout);
    if (allowed === null && /cannot impersonate|forbidden/i.test(r.stderr)) {
      note = "Could not impersonate the subject — your kubeconfig may lack impersonate permission.";
    }
    results.push({ ...check, allowed });
  }
  return { results, note };
}
