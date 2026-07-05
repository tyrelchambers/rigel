// Single source of truth for classifying a chat Bash command against the cluster.
// Two consumers:
//   - the in-app assistant + agent shim use classifyCommand() (allow reads, deny
//     mutations → routed to an approve-and-run action).
//   - the agent's chat hook uses classifyTier() (read/reversible auto-run,
//     destructive confirm-over-text, blocked refused).
// Security note: false positives (denying a read) only cost an approval; false
// NEGATIVES (auto-running a destructive op) are the danger, so verb detection
// skips global flags+values precisely and unknown mutation shapes bias to
// "destructive".

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
const READONLY_SUBCOMMANDS: Record<string, Set<string>> = {
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
]);

export type Tier = "read" | "reversible" | "destructive" | "blocked";

export interface TierVerdict {
  tier: Tier;
  reason: string;
}

export interface CommandVerdict {
  decision: "allow" | "deny";
  reason: string;
}

const APPROVAL_HINT =
  "This changes the cluster, so it can't run unattended. Do NOT retry it via Bash. " +
  "Instead emit a ```action block so the user gets an approve-and-run button — use a " +
  "specific kind when one fits, or {\"kind\":\"command\",\"args\":[<kubectl args WITHOUT " +
  "the binary or --context>],\"destructive\":true} for anything else.";

const CONFIRM_HINT =
  "This is a DESTRUCTIVE change (irreversible). Do NOT run it via Bash. Describe exactly " +
  "what you would run and why in one or two lines, then emit a ```action block " +
  "{\"kind\":\"command\",\"args\":[<kubectl/helm args WITHOUT the binary or --context>]," +
  "\"destructive\":true,\"label\":\"<short label>\"} so the operator can reply \"yes\" to run it.";

const BLOCKED_HINT =
  "kubectl port-forward / proxy can't run in this chat — they block with no terminal. " +
  "Do NOT retry it. Tell the user to use Rigel's built-in port-forward feature instead.";

function crossContextHint(active: string): string {
  return (
    `This command targets a DIFFERENT cluster than the active one (\`${active}\`). ` +
    `You can only modify the active cluster. Do NOT retry it via Bash and do NOT raise an ` +
    `action block for it. Tell the user to switch to that cluster first if they want to modify it.`
  );
}

function unquote(t: string): string {
  return t.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

function findVerb(tokens: string[]): { verb: string | null; sub: string | null } {
  let i = 0;
  let verb: string | null = null;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) {
      if (VALUE_FLAGS.has(t)) i++;
      continue;
    }
    verb = t;
    break;
  }
  let sub: string | null = null;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.startsWith("-")) {
      if (VALUE_FLAGS.has(t)) j++;
      continue;
    }
    sub = t;
    break;
  }
  return { verb, sub };
}

/** Tier of one kubectl invocation (tokens after the binary). null = read. */
function kubectlTier(rest: string[]): Tier | null {
  const { verb, sub } = findVerb(rest);
  if (!verb) return null;
  if (KUBECTL_BLOCKED.has(verb)) return "blocked";
  if (KUBECTL_READ_PARENTS.has(verb)) {
    const readSubs = READONLY_SUBCOMMANDS[verb];
    return readSubs && sub && readSubs.has(sub) ? null : "reversible";
  }
  if (verb === "rollout") {
    const readSubs = READONLY_SUBCOMMANDS[verb];
    if (readSubs && sub && readSubs.has(sub)) return null;
    return "reversible";
  }
  if (KUBECTL_DESTRUCTIVE.has(verb) || KUBECTL_POD_EXEC.has(verb)) return "destructive";
  if (KUBECTL_REVERSIBLE.has(verb)) return "reversible";
  return null;
}

function helmTier(rest: string[]): Tier | null {
  const { verb } = findVerb(rest);
  if (!verb) return null;
  if (HELM_DESTRUCTIVE.has(verb)) return "destructive";
  if (HELM_REVERSIBLE.has(verb)) return "reversible";
  return null;
}

const RANK: Record<Tier, number> = { read: 0, blocked: 1, reversible: 2, destructive: 3 };

/** Highest tier across every kubectl/helm invocation in one shell segment. */
function segmentTier(segment: string): Tier {
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

function segmentContexts(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if ((t === "--context" || t === "--kube-context") && i + 1 < tokens.length) {
      out.push(unquote(tokens[i + 1]!));
    } else {
      const m = t.match(/^--(?:kube-)?context=(.+)$/);
      if (m) out.push(unquote(m[1]!));
    }
  }
  return out;
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

/** 2-tier compatibility for the in-app assistant + the agent read-shim: any
 *  mutation (reversible or destructive) denies to an action block; reads allow.
 *  Preserves the cross-context steer. */
export function classifyCommand(command: string, activeContext?: string | null): CommandVerdict {
  const { tier } = classifyTier(command);
  if (tier === "read") return { decision: "allow", reason: "non-mutating — read/investigation command" };
  if (tier === "blocked") return { decision: "deny", reason: BLOCKED_HINT };
  // reversible or destructive → mutation
  if (activeContext) {
    for (const seg of command.split(/;|&&|\|\||\||\n/)) {
      if (segmentTier(seg) === "reversible" || segmentTier(seg) === "destructive") {
        if (segmentContexts(seg).some((c) => c !== activeContext)) {
          return { decision: "deny", reason: crossContextHint(activeContext) };
        }
      }
    }
  }
  return { decision: "deny", reason: APPROVAL_HINT };
}
