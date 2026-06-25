// Denylist permission policy for the agent's read-only investigation.
//
// The agent investigates freely (reads) but must NEVER mutate during
// investigation, so we DENYLIST: anything that isn't a cluster MUTATION is
// auto-allowed; kubectl/helm verbs that change cluster state are denied (the
// deterministic execution phase, not the model, performs approved mutations).
//
// Security note: false positives (denying a read) just cost an investigation
// step; false NEGATIVES (allowing a mutation) are the danger, so verb detection
// skips global flags+values precisely, and unknown shapes bias toward "allow"
// only for non kubectl/helm commands. kubectl/helm verbs are matched against sets.

/** kubectl verbs that change cluster (or pod) state → denied. */
const KUBECTL_MUTATING = new Set([
  "apply", "create", "delete", "patch", "edit", "replace", "scale",
  "annotate", "label", "set", "expose", "autoscale", "run", "apply",
  "cordon", "uncordon", "drain", "taint", "exec", "cp", "attach", "debug",
  "rollout", "auth", // refined below: rollout status/history & auth can-i are reads
  "certificate", "approve", "deny", "evict", "delete-context",
]);

/** `rollout`/`auth` subcommands that are READ-ONLY (so not every rollout/auth denies). */
const READONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  rollout: new Set(["status", "history"]),
  auth: new Set(["can-i", "whoami"]),
};

/**
 * kubectl verbs that don't mutate but can't run headless — they block forever
 * with no terminal. Denied with a "blocked" reason rather than the action reason.
 */
const KUBECTL_BLOCKED = new Set(["port-forward", "proxy"]);

/** helm verbs that change cluster state → denied. */
const HELM_MUTATING = new Set([
  "install", "upgrade", "uninstall", "delete", "rollback",
]);

/**
 * kubectl/helm GLOBAL flags that consume the NEXT token as their value (when not
 * written as `--flag=value`). We must skip both so the value isn't mistaken for
 * the verb (e.g. `kubectl -n personal get` → skip `-n personal`, verb = `get`).
 */
const VALUE_FLAGS = new Set([
  "--context", "--namespace", "-n", "--kubeconfig", "--cluster", "--user",
  "--as", "--as-group", "--as-uid", "--token", "-s", "--server",
  "--tls-server-name", "--certificate-authority", "--client-certificate",
  "--client-key", "--request-timeout", "--cache-dir", "-o", "--output",
  "--chunk-size", "--profile", "--profile-output", "--log-flush-frequency",
  // helm connection flags
  "--kube-context", "--kube-apiserver", "--kube-token", "--kube-as-user",
  "--kube-as-group", "--kube-ca-file", "--registry-config",
  "--repository-config", "--repository-cache", "--burst-limit",
]);

export interface CommandVerdict {
  decision: "allow" | "deny";
  /** Why — for deny, this is fed back to the model to steer it away from mutating. */
  reason: string;
}

const APPROVAL_HINT =
  "This changes the cluster, so it can't run during investigation. Do NOT retry it via Bash. " +
  "If a fix is warranted, describe it in prose / emit a single ```action block so it can be " +
  "queued for approval — never run a mutating kubectl/helm command yourself.";

const BLOCKED_HINT =
  "kubectl port-forward / proxy can't run here — they block with no terminal. Do NOT retry it.";

/** First non-flag token after the binary = the verb. Skips global flags + values. */
function findVerb(tokens: string[]): { verb: string | null; sub: string | null } {
  let i = 0;
  let verb: string | null = null;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) {
      if (VALUE_FLAGS.has(t)) i++; // skip the flag's space-separated value
      continue; // `--flag=value`, bare `-`, or boolean flag
    }
    verb = t;
    break;
  }
  // the next non-flag token after the verb (sub-command, e.g. `rollout status`)
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

/** Drop surrounding quotes so `sh -c "kubectl delete …"` tokens compare cleanly. */
function unquote(t: string): string {
  return t.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

/** What a kubectl invocation (tokens after the binary) amounts to. */
type Category = "mutation" | "blocked" | null;

function kubectlCategory(rest: string[]): Category {
  const { verb, sub } = findVerb(rest);
  if (!verb) return null;
  if (KUBECTL_MUTATING.has(verb)) {
    const readSubs = READONLY_SUBCOMMANDS[verb];
    if (readSubs && sub && readSubs.has(sub)) return null;
    return "mutation";
  }
  if (KUBECTL_BLOCKED.has(verb)) return "blocked";
  return null;
}

/**
 * Categorize one pipeline/chain segment. Scans for `kubectl`/`k`/`helm` at ANY
 * token position (after quote-stripping), so wrappers like `xargs kubectl delete`,
 * `sh -c "kubectl delete …"`, `watch`/`timeout`/`env` are caught. "mutation"
 * outranks "blocked".
 */
function segmentCategory(segment: string): Category {
  const tokens = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  let blocked = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "kubectl" || t === "k") {
      const c = kubectlCategory(tokens.slice(i + 1));
      if (c === "mutation") return "mutation";
      if (c === "blocked") blocked = true;
    } else if (t === "helm") {
      const { verb } = findVerb(tokens.slice(i + 1));
      if (verb != null && HELM_MUTATING.has(verb)) return "mutation";
    }
  }
  return blocked ? "blocked" : null;
}

/**
 * Classify a Bash command. Splits on shell separators (; && || | and newlines)
 * and treats the command as a mutation if ANY segment is one. A `$(...)`/backtick
 * substitution that hides a kubectl/helm mutation is caught by a coarse backstop.
 */
export function classifyCommand(command: string): CommandVerdict {
  let blocked = false;
  const scan = (text: string) => {
    for (const seg of text.split(/;|&&|\|\||\||\n/)) {
      const c = segmentCategory(seg);
      if (c === "mutation") return "mutation" as const;
      if (c === "blocked") blocked = true;
    }
    return null;
  };

  if (scan(command) === "mutation") return { decision: "deny", reason: APPROVAL_HINT };
  if (/[`$]\(?/.test(command)) {
    const inner = command.match(/\$\(([^)]*)\)|`([^`]*)`/g) ?? [];
    for (const m of inner) {
      const body = m.replace(/^\$\(|^`|\)$|`$/g, "");
      if (scan(body) === "mutation") return { decision: "deny", reason: APPROVAL_HINT };
    }
  }
  if (blocked) return { decision: "deny", reason: BLOCKED_HINT };
  return { decision: "allow", reason: "non-mutating — read/investigation command" };
}
