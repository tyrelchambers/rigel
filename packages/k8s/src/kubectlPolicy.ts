// Single source of truth for classifying a chat Bash command against the cluster.
// Two consumers:
//   - the in-app assistant + agent shim use classifyCommand() (allow reads, deny
//     mutations → routed to an approve-and-run action).
//   - the agent's chat hook uses classifyTier() (read/reversible auto-run,
//     destructive confirm-over-text, blocked refused).
// Security note: false positives (denying a read) only cost an approval; false
// NEGATIVES (auto-running a destructive op) are the danger, so verb detection
// skips global flags+values precisely. This is a DENYLIST keyed on explicit
// mutation verb sets: unrecognized verbs — including kubectl plugin subcommands
// like `kubectl cnpg destroy` — are treated as READS. The classifier does NOT
// bias unknown verbs to destructive, so unrecognized plugin mutations are bounded
// by RBAC (the cluster's hard ceiling), not this classifier.

import { flagValues } from "./shellWords";

/** kubectl verbs that change cluster/pod state and are REVERSIBLE. */
const KUBECTL_REVERSIBLE = new Set([
  "apply", "create", "patch", "edit", "replace", "scale",
  "annotate", "label", "set", "expose", "autoscale", "run",
  "cordon", "uncordon", "taint", "rollout", "certificate", "approve", "deny",
]);

/** kubectl verbs that DESTROY resources / data — irreversible, confirm over text. */
const KUBECTL_DESTRUCTIVE = new Set([
  "delete", "drain", "evict", "delete-context",
]);

/** kubectl verbs that mutate a live pod (treat as destructive: side effects, no undo). */
const KUBECTL_POD_EXEC = new Set(["exec", "cp", "attach", "debug"]);

/** `rollout`/`auth` subcommands that are READ-ONLY. */
export const KUBECTL_READONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  rollout: new Set(["status", "history"]),
  auth: new Set(["can-i", "whoami"]),
};

/** verbs that can't run headless — block forever with no terminal. */
const KUBECTL_BLOCKED = new Set(["port-forward", "proxy"]);

/** `auth` is read (can-i/whoami) — anything else under auth is not a mutation here. */
const KUBECTL_READ_PARENTS = new Set(["auth"]);

const HELM_REVERSIBLE = new Set(["install", "upgrade", "rollback"]);
const HELM_DESTRUCTIVE = new Set(["uninstall", "delete"]);

const VALUE_FLAGS = new Set([
  "--context", "--namespace", "-n", "--kubeconfig", "--cluster", "--user",
  "--as", "--as-group", "--as-uid", "--token", "-s", "--server",
  "--tls-server-name", "--certificate-authority", "--client-certificate",
  "--client-key", "--request-timeout", "--cache-dir", "-o", "--output",
  "--chunk-size", "--profile", "--profile-output", "--log-flush-frequency",
  "--kube-context", "--kube-apiserver", "--kube-token", "--kube-as-user",
  "--kube-as-group", "--kube-ca-file", "--registry-config",
  "--repository-config", "--repository-cache", "--burst-limit",
  "-v", "--v", "--vmodule",
]);

export const KUBECTL_GLOBAL_BOOLEANS: ReadonlySet<string> = new Set([
  "--insecure-skip-tls-verify", "--match-server-version", "--warnings-as-errors", "--disable-compression", "-h", "--help",
]);
const HELM_GLOBAL_BOOLEANS: ReadonlySet<string> = new Set(["--debug", "-h", "--help"]);

export interface StrictFlags {
  booleans: ReadonlySet<string>;
  anyAssignment: boolean;
}

const LOCAL_KUBECTL_FLAGS: StrictFlags = { booleans: KUBECTL_GLOBAL_BOOLEANS, anyAssignment: true };
const LOCAL_HELM_FLAGS: StrictFlags = { booleans: HELM_GLOBAL_BOOLEANS, anyAssignment: true };

export type Tier = "read" | "reversible" | "destructive" | "blocked";

export interface TierVerdict {
  tier: Tier;
  reason: string;
}

const CONFIRM_HINT =
  "This is a DESTRUCTIVE change (irreversible). Do NOT run it via Bash. Describe exactly " +
  "what you would run and why in one or two lines, then emit a ```action block " +
  "{\"kind\":\"command\",\"args\":[<kubectl/helm args WITHOUT the binary or --context>]," +
  "\"destructive\":true,\"label\":\"<short label>\"} so the operator can reply \"yes\" to run it.";

export const BLOCKED_HINT =
  "kubectl port-forward / proxy can't run in this chat — they block with no terminal. " +
  "Do NOT retry it. Tell the user to use Rigel's built-in port-forward feature instead.";

function unquote(t: string): string {
  return t.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

const UNKNOWN_FLAG = -2;

function knownFlag(t: string, strict: StrictFlags): boolean {
  if (strict.booleans.has(t)) return true;
  const eq = t.indexOf("=");
  return eq > 0 && (strict.anyAssignment || VALUE_FLAGS.has(t.slice(0, eq)));
}

function nextWord(tokens: readonly string[], from: number, strict?: StrictFlags): number {
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("-")) return i;
    if (VALUE_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (strict && !knownFlag(t, strict)) return UNKNOWN_FLAG;
  }
  return -1;
}

/**
 * The verb and first subcommand of one kubectl/helm invocation (tokens after the
 * binary). With `strict`, it fails closed: a flag before the verb or subcommand
 * that is neither a value flag nor a known boolean ends the search and sets
 * `unknownFlag`, because cobra reads an unknown `--flag` as consuming the next token.
 */
export function findVerb(
  tokens: readonly string[],
  strict?: StrictFlags,
): { verb: string | null; sub: string | null; unknownFlag: boolean } {
  const vi = nextWord(tokens, 0, strict);
  if (vi < 0) return { verb: null, sub: null, unknownFlag: vi === UNKNOWN_FLAG };
  const si = nextWord(tokens, vi + 1, strict);
  return { verb: tokens[vi]!, sub: si < 0 ? null : tokens[si]!, unknownFlag: false };
}

/** Tier of one kubectl invocation (tokens after the binary). null = read. */
function kubectlTier(rest: string[]): Tier | null {
  const { verb, sub, unknownFlag } = findVerb(rest, LOCAL_KUBECTL_FLAGS);
  if (unknownFlag) return "destructive";
  if (!verb) return null;
  if (KUBECTL_BLOCKED.has(verb)) return "blocked";
  if (KUBECTL_READ_PARENTS.has(verb)) {
    const readSubs = KUBECTL_READONLY_SUBCOMMANDS[verb];
    return readSubs && sub && readSubs.has(sub) ? null : "reversible";
  }
  if (verb === "rollout") {
    const readSubs = KUBECTL_READONLY_SUBCOMMANDS[verb];
    if (readSubs && sub && readSubs.has(sub)) return null;
    return "reversible";
  }
  if (KUBECTL_DESTRUCTIVE.has(verb) || KUBECTL_POD_EXEC.has(verb)) return "destructive";
  if (KUBECTL_REVERSIBLE.has(verb)) return "reversible";
  return null;
}

function helmTier(rest: string[]): Tier | null {
  const { verb, unknownFlag } = findVerb(rest, LOCAL_HELM_FLAGS);
  if (unknownFlag) return "destructive";
  if (!verb) return null;
  if (HELM_DESTRUCTIVE.has(verb)) return "destructive";
  if (HELM_REVERSIBLE.has(verb)) return "reversible";
  return null;
}

const RANK: Record<Tier, number> = { read: 0, blocked: 1, reversible: 2, destructive: 3 };

/** Highest tier across every kubectl/helm invocation in one shell segment. */
export function segmentTier(segment: string): Tier {
  const tokens = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  let tier: Tier = "read";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    let c: Tier | null = null;
    if (t === "kubectl" || t === "k") c = kubectlTier(tokens.slice(i + 1));
    else if (t === "helm") c = helmTier(tokens.slice(i + 1));
    if (c && RANK[c] > RANK[tier]) tier = c;
  }
  return tier;
}

export function segmentContexts(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  return flagValues(tokens, ["--context", "--kube-context"]).map(unquote);
}

/** Classify a full Bash command into a tier (highest across all segments and
 *  command substitutions). A mutation with no recognizable verb never appears
 *  here — that path only tiers recognized kubectl/helm verbs; free reads are
 *  "read". Wrapped mutations (`sh -c`, `xargs`) are caught because we scan for
 *  kubectl/helm at ANY token position within each segment. */
export function classifyTier(command: string): TierVerdict {
  let tier: Tier = "read";
  const scan = (text: string) => {
    for (const seg of text.split(/;|&&|\|\||\||\n/)) {
      const c = segmentTier(seg);
      if (RANK[c] > RANK[tier]) tier = c;
    }
  };
  scan(command);
  if (/[`$]\(?/.test(command)) {
    const inner = command.match(/\$\(([^)]*)\)|`([^`]*)`/g) ?? [];
    for (const m of inner) scan(m.replace(/^\$\(|^`|\)$|`$/g, ""));
  }
  const reason =
    tier === "read" ? "read/investigation command"
      : tier === "reversible" ? "reversible mutation"
        : tier === "blocked" ? BLOCKED_HINT
          : CONFIRM_HINT;
  return { tier, reason };
}

/**
 * A read that would print a Secret's values, rather than its shape.
 *
 * Surfaces that own their output redact instead of refusing (see
 * secretRedaction.ts), but a shell command's output goes straight into the
 * model's context and into a persisted transcript with nothing in between, so
 * here the command itself is what has to be stopped. kubectl's own `describe
 * secret` prints the keys, types and byte counts with no values, which is the
 * same shape a redacted read gives, so the refusal names it.
 *
 * Deliberately NOT part of classifyCommand, which answers what a command does
 * rather than what its output carries. Whether a Secret read is refused depends
 * on whether the caller can redact: the voice read path can and does, the chat
 * shell cannot, so each applies this itself.
 */
export function printsSecretValues(command: string): boolean {
  if (!/\bkubectl\b/.test(command)) return false;
  if (!/\bsecrets?\b|\bsecret\//.test(command)) return false;
  if (!/\bget\b/.test(command)) return false;
  return /-o[= ]?\s*(yaml|json|jsonpath|go-template|custom-columns)/.test(command);
}

export const SECRET_VALUES_HINT =
  "denied: that would print a Secret's values into the transcript. Use `kubectl describe secret <name> -n <ns>`, which gives you the keys, their types and their sizes without the values.";
