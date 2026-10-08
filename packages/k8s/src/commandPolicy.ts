import { BLOCKED_HINT, classifyTier, segmentContexts, segmentTier } from "./kubectlPolicy";
import { commandIndex, parseShell, splitHead, type ShellSegment } from "./shellWords";
import { classifyShellSsh, SSH_FAMILY } from "./sshPolicy";

export {
  classifyTier,
  printsSecretValues,
  SECRET_VALUES_HINT,
  type Tier,
  type TierVerdict,
} from "./kubectlPolicy";

export interface CommandVerdict {
  decision: "allow" | "deny";
  reason: string;
}

const APPROVAL_HINT =
  "This changes the cluster, so it can't run unattended. Do NOT retry it via Bash. " +
  "Instead emit a ```action block so the user gets an approve-and-run button — use a " +
  "specific kind when one fits, or {\"kind\":\"command\",\"args\":[<kubectl args WITHOUT " +
  "the binary or --context>],\"destructive\":true} for anything else.";

function crossContextHint(active: string): string {
  return (
    `This command targets a DIFFERENT cluster than the active one (\`${active}\`). ` +
    `You can only modify the active cluster. Do NOT retry it via Bash and do NOT raise an ` +
    `action block for it. Tell the user to switch to that cluster first if they want to modify it.`
  );
}

const PARSE_HINT =
  "This command couldn't be parsed (an unbalanced quote or a trailing backslash). Fix the quoting and run it again; avoid heredocs and $'...' quoting here.";

const DYNAMIC_HEAD_HINT =
  "A command here can't start with a variable, a glob or a brace expansion (bash would expand `ss[h]`, `s{s,x}h`, `$cmd` or `{ssh,}` before this check sees it). Write the command name out literally, e.g. `kubectl get pods`.";

const PATH_TOOL_HINT =
  "Call `kubectl`, `k` and `helm` by their bare name, not a full path, so the policy can classify them.";

const BARE_HEADS = new Set(["[", "[[", ":", ")", "}"]);
const SAFE_HEAD = /^[A-Za-z0-9._/+-]+$/;
const PATH_TOOLS = new Set(["kubectl", "k", "helm"]);

function globsIntoBinDir(word: string, glob: boolean): boolean {
  const { dir } = splitHead(word);
  return glob && dir !== null && dir.split("/").some((seg) => seg === "bin" || seg === "sbin");
}

function headVerdict(segments: readonly ShellSegment[]): CommandVerdict | null {
  for (const seg of segments) {
    if (seg.words.some((w, i) => globsIntoBinDir(w, seg.wordGlobs[i]!))) {
      return { decision: "deny", reason: DYNAMIC_HEAD_HINT };
    }
    const hi = commandIndex(seg.words);
    if (hi < 0) continue;
    const head = seg.words[hi]!;
    if (BARE_HEADS.has(head)) continue;
    if (seg.wordGlobs[hi] || !SAFE_HEAD.test(head)) {
      return { decision: "deny", reason: DYNAMIC_HEAD_HINT };
    }
    const { dir, name } = splitHead(head);
    if (dir !== null && PATH_TOOLS.has(name)) return { decision: "deny", reason: PATH_TOOL_HINT };
  }
  return null;
}

function mentionsSsh(command: string, segments: readonly ShellSegment[]): boolean {
  return SSH_FAMILY.test(command) || segments.some((s) => s.words.some((w) => SSH_FAMILY.test(w)));
}

/** 2-tier compatibility for the in-app assistant + the agent read-shim: any
 *  mutation (reversible or destructive) denies to an action block; reads allow.
 *  Preserves the cross-context steer. ssh segments are routed through the SSH
 *  policy against `sshHosts`, and only the local remainder is tiered here. */
export function classifyCommand(
  command: string,
  activeContext?: string | null,
  sshHosts: readonly string[] = [],
): CommandVerdict {
  const parsed = parseShell(command);
  if (!parsed) return { decision: "deny", reason: PARSE_HINT };
  const head = headVerdict(parsed.segments);
  if (head) return head;
  let scanned = command;
  if (mentionsSsh(command, parsed.segments)) {
    const ssh = classifyShellSsh(parsed, sshHosts);
    if (ssh.decision === "deny") return ssh;
    scanned = ssh.local;
  }
  const { tier } = classifyTier(scanned);
  if (tier === "read") return { decision: "allow", reason: "non-mutating — read/investigation command" };
  if (tier === "blocked") return { decision: "deny", reason: BLOCKED_HINT };
  // reversible or destructive → mutation
  if (activeContext) {
    for (const seg of scanned.split(/;|&&|\|\||\||\n/)) {
      const segTier = segmentTier(seg);
      if (segTier === "reversible" || segTier === "destructive") {
        if (segmentContexts(seg).some((c) => c !== activeContext)) {
          return { decision: "deny", reason: crossContextHint(activeContext) };
        }
      }
    }
  }
  return { decision: "deny", reason: APPROVAL_HINT };
}
