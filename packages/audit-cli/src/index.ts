// packages/audit-cli/src/index.ts
// `rigel-audit <reliability|security|performance> [--context X] [--namespace Y] [--json]`
// Runs the deterministic audit engines over live kubectl and prints the
// findings JSON. The chat assistant's audit skills shell out to this.
//
// Everything cluster-touching goes through an injected KubectlRunner (see
// kubectl.ts + gather.ts), so this file's job is only: parse args, wire the
// real runner, dispatch, print. The dispatch (runAudit) takes a runner so it is
// itself unit-testable with a stub — no cluster needed.
import { realKubectlRunner, type KubectlRunner } from "./kubectl";
import {
  gatherWorkloadResources,
  detectBackend,
  gatherUsageProvider,
} from "./gather";
import {
  runReliability,
  runSecurity,
  runPerformance,
  type AuditKind,
  type AuditRunResult,
} from "./audits";
import { canRunAudit, parseUnlockedAudits, type AuditEntitlement } from "@rigel/k8s";

const AUDIT_KINDS: readonly AuditKind[] = ["reliability", "security", "performance"];

export interface ParsedArgs {
  kind: AuditKind;
  context: string | null;
  namespace?: string;
  json: boolean;
}

const USAGE =
  "Usage: rigel-audit <reliability|security|performance> [--context <ctx>] [--namespace <ns>] [--json]";

function isAuditKind(v: string): v is AuditKind {
  return (AUDIT_KINDS as readonly string[]).includes(v);
}

/** Parse argv (without node/script head). Throws Error on any invalid input. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let context: string | null = null;
  let namespace: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--context" || a === "--namespace") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} requires a value`);
      if (a === "--context") context = value;
      else namespace = value;
    } else if (a === "-h" || a === "--help") {
      throw new Error(USAGE);
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length === 0) throw new Error(`Missing audit kind.\n${USAGE}`);
  if (positionals.length > 1) throw new Error(`Unexpected extra arguments: ${positionals.slice(1).join(" ")}\n${USAGE}`);
  const kind = positionals[0];
  if (!isAuditKind(kind)) {
    throw new Error(`Unknown audit kind: ${kind}. Expected one of ${AUDIT_KINDS.join(", ")}.\n${USAGE}`);
  }
  return { kind, context, namespace, json };
}

/** The performance audit reports whether it used a metrics backend so the skill
 *  can explain when findings lack sizing evidence. Other audits omit it. */
export interface AuditOutput extends AuditRunResult<unknown> {
  /** Present only for the performance audit. */
  metricsBackend?: { used: false } | { used: true; flavor: string; service: string; namespace: string };
}

/** Run one audit against an injected runner. Unit-testable with a stub runner. */
export async function runAudit(
  kind: AuditKind,
  runner: KubectlRunner,
  namespace?: string,
  entitlement: AuditEntitlement = parseUnlockedAudits(process.env.RIGEL_UNLOCKED_AUDITS),
): Promise<AuditOutput> {
  const gate = canRunAudit(kind, entitlement);
  if (!gate.allowed) throw new Error(gate.reason ?? `The ${kind} audit is not available on this plan.`);

  const input = await gatherWorkloadResources(runner, namespace);

  if (kind === "reliability") return runReliability(input);
  if (kind === "security") return runSecurity({ workloads: input.workloads });

  // performance (hybrid): use real usage when a metrics backend is present,
  // else spec-only (no evidence, no metrics-based findings).
  const backend = await detectBackend(runner);
  const usage = backend ? await gatherUsageProvider(runner, backend, namespace) : undefined;
  const result = runPerformance({ workloads: input.workloads, hpas: input.hpas, usage });
  return {
    ...result,
    metricsBackend: backend
      ? { used: true, flavor: backend.flavor, service: backend.service, namespace: backend.namespace }
      : { used: false },
  };
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  try {
    const output = await runAudit(args.kind, realKubectlRunner(args.context), args.namespace);
    process.stdout.write(JSON.stringify(output, null, args.json ? 0 : 2) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`rigel-audit ${args.kind} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// Entrypoint (skipped under test import).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
