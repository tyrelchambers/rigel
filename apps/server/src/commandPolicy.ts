// Denylist permission policy for the chat's Bash tool.
//
// The chat copilot must investigate freely (reads), so we DENYLIST rather than
// allowlist: anything that isn't a cluster MUTATION is auto-allowed; kubectl/helm
// verbs that change cluster state are denied and routed to the app's confirm-sheet
// approval (a ```action block, `command` kind), so the user approves the exact
// command and it runs — instead of the old allowlist insta-failing reordered reads.
//
// Security note: false positives (denying a read) just cost an approval; false
// NEGATIVES (allowing a mutation) are the danger, so verb detection skips global
// flags+values precisely, and unknown shapes bias toward "allow" only for non
// kubectl/helm commands. kubectl/helm verbs are matched against explicit sets.

/** kubectl verbs that change cluster (or pod) state → require approval. */
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
 * kubectl verbs that don't mutate but can't run in a headless chat turn — they
 * block forever with no terminal. Denied with a "use the app's feature" reason
 * rather than the action-block reason (there's no action-block target for them).
 */
const KUBECTL_BLOCKED = new Set(["port-forward", "proxy"]);

/** helm verbs that change cluster state → require approval. */
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
  /** Why — for deny, this is fed back to the model to steer it to an action block. */
  reason: string;
}

const APPROVAL_HINT =
  "This changes the cluster, so it can't run unattended. Do NOT retry it via Bash. " +
  "Instead emit a ```action block so the user gets an approve-and-run button — use a " +
  "specific kind when one fits, or {\"kind\":\"command\",\"args\":[<kubectl args WITHOUT " +
  "the binary or --context>],\"destructive\":true} for anything else.";

const BLOCKED_HINT =
  "kubectl port-forward / proxy can't run in this chat — they block with no terminal. " +
  "Do NOT retry it. Tell the user to use Rigel's built-in port-forward feature instead.";

const CROSS_CONTEXT_HINT =
  "This is a cluster mutation targeting a DIFFERENT context than the active one. " +
  "Do NOT retry it via Bash. Switch the active cluster first if intended, then emit a " +
  "```action block so the user approves the exact command.";

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

/**
 * The `--context`/`--kube-context` value in a token list (after the binary), or
 * null if none is given. Accepts both `--context x` and `--context=x`. Used to
 * tell a cross-context mutation (different cluster than the active one) apart from
 * a same-context one, so it can carry a clearer steering reason.
 */
function explicitContext(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--context" || t === "--kube-context") return tokens[i + 1] ?? null;
    const eq = t.match(/^--(?:kube-)?context=(.*)$/);
    if (eq) return eq[1] ?? null;
  }
  return null;
}

/**
 * What a kubectl/helm invocation amounts to. "cross-context" is a mutation whose
 * explicit `--context` differs from the active cluster — still denied, but with a
 * clearer steering reason (switch clusters first) than the generic action-block hint.
 */
type Category = "cross-context" | "mutation" | "blocked" | null;

function kubectlCategory(rest: string[]): Category {
  const { verb, sub } = findVerb(rest);
  if (!verb) return null;
  if (KUBECTL_MUTATING.has(verb)) {
    // rollout status/history and auth can-i/whoami are reads despite the parent verb
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
 * `sh -c "kubectl delete …"`, `watch`/`timeout`/`env` are caught — not just
 * commands that START with kubectl/helm. A mutation pinned to a context other than
 * `activeContext` reports "cross-context"; otherwise "mutation" outranks "blocked".
 */
function segmentCategory(segment: string, activeContext: string | null): Category {
  const tokens = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  let blocked = false;
  // a mutation targeting a context other than the active one carries a clearer reason
  const isCross = (rest: string[]): boolean => {
    if (!activeContext) return false;
    const ctx = explicitContext(rest);
    return ctx != null && ctx !== activeContext;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "kubectl" || t === "k") {
      const rest = tokens.slice(i + 1);
      const c = kubectlCategory(rest);
      if (c === "mutation") return isCross(rest) ? "cross-context" : "mutation";
      if (c === "blocked") blocked = true;
    } else if (t === "helm") {
      const rest = tokens.slice(i + 1);
      const { verb } = findVerb(rest);
      if (verb != null && HELM_MUTATING.has(verb)) {
        return isCross(rest) ? "cross-context" : "mutation";
      }
    }
  }
  return blocked ? "blocked" : null;
}

/**
 * Classify a Bash command. Splits on shell separators (; && || | and newlines)
 * and treats the command as a mutation if ANY segment is one. A `$(...)`/backtick
 * substitution that hides a kubectl/helm mutation is caught by a coarse backstop.
 * `activeContext` (the selected cluster, e.g. KUBECONFIG_CONTEXT) lets a mutation
 * aimed at a different context be denied with a cross-context steering reason.
 */
export function classifyCommand(
  command: string,
  activeContext: string | null = null,
): CommandVerdict {
  let blocked = false;
  let crossContext = false;
  const scan = (text: string) => {
    for (const seg of text.split(/;|&&|\|\||\||\n/)) {
      const c = segmentCategory(seg, activeContext);
      if (c === "mutation") return "mutation" as const;
      if (c === "cross-context") crossContext = true;
      if (c === "blocked") blocked = true;
    }
    return null;
  };

  const denyForMutation = (): CommandVerdict =>
    crossContext
      ? { decision: "deny", reason: CROSS_CONTEXT_HINT }
      : { decision: "deny", reason: APPROVAL_HINT };

  if (scan(command) === "mutation") return denyForMutation();
  // backstop: command substitution can hide a kubectl/helm call from the split
  if (/[`$]\(?/.test(command)) {
    const inner = command.match(/\$\(([^)]*)\)|`([^`]*)`/g) ?? [];
    for (const m of inner) {
      const body = m.replace(/^\$\(|^`|\)$|`$/g, "");
      if (scan(body) === "mutation") return denyForMutation();
    }
  }
  if (crossContext) return denyForMutation();
  if (blocked) return { decision: "deny", reason: BLOCKED_HINT };
  return { decision: "allow", reason: "non-mutating — read/investigation command" };
}
