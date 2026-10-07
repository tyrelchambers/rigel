import {
  classifyTier,
  findVerb,
  KUBECTL_GLOBAL_BOOLEANS,
  KUBECTL_READONLY_SUBCOMMANDS,
  printsSecretValues,
  type StrictFlags,
} from "./kubectlPolicy";
import { ASSIGNMENT, flagValues, parseShell, splitHead, type ParsedShell, type ShellSegment } from "./shellWords";

export type SshDecision = "read" | "approve" | "deny";

export interface SshVerdict {
  decision: SshDecision;
  reason: string;
}

export type ShellSshVerdict =
  | { decision: "allow"; reason: string; local: string }
  | { decision: "deny"; reason: string };

export const SSH_BATCH_ARGS = ["-T", "-o", "BatchMode=yes"] as const;

export const SSH_TRANSFER_TOOLS: readonly string[] = ["scp", "sftp", "rsync", "sshfs", "sshpass", "autossh", "mosh"];

export const SSH_FAMILY = new RegExp(
  "(?:^|[\\s;|&(`'\"/=])(?:" + ["ssh", ...SSH_TRANSFER_TOOLS].join("|") + ")(?=$|[\\s;|&)`'\"])",
);

const SSH_VALUE_FLAGS = new Set("BbcDEeFIiJLlmOopQRSWw".split(""));
const SSH_BOOL_FLAGS = new Set("46aCgGKknqTVvxy".split(""));
const SSH_DENY_FLAGS = new Set("ADEFfIJLMNORSstWwXY".split(""));
const SSH_ALLOWED_OPTIONS = new Set([
  "connecttimeout", "serveraliveinterval", "serveralivecountmax", "batchmode", "loglevel",
  "port", "user", "identityfile", "identitiesonly", "connectionattempts", "compression", "addressfamily",
]);

export const SSH_INDIRECT_HINT =
  "SSH has to be the first word of its own command: `ssh <alias> '<remote command>'`. " +
  "It can't be wrapped (sh -c, xargs, a variable, a full path) and scp, sftp and rsync aren't available. " +
  "Do NOT retry a variation; run it directly in that form. " +
  "If ssh is only text you are searching for, write the pattern so it isn't a bare word, e.g. `grep -r 'sshd' /etc` or `grep 'ssh[ :]'`.";

const INTERACTIVE_HINT =
  "Interactive SSH sessions (no remote command, -t, -N) can't run in this chat. Pass the command to run: `ssh <alias> '<command>'`.";

function hostHint(host: string, enabled: readonly string[]): string {
  return enabled.length
    ? `\`${host}\` isn't an SSH host the user enabled for chat. Enabled hosts: ${enabled.join(", ")}. Do NOT retry; tell the user to enable it in Settings > AI agents > SSH hosts if they want you to use it.`
    : "No SSH hosts are enabled for chat. Tell the user they can enable hosts from their ~/.ssh/config in Settings > AI agents > SSH hosts.";
}

function approvalHint(host: string): string {
  return (
    `This command changes ${host} or isn't on the read-only list, so it can't run unattended. Do NOT retry it via Bash. ` +
    `Emit a \`\`\`action block {"kind":"sshCommand","label":"<short label>","host":"${host}","command":"<the exact remote command>"} ` +
    `so the user gets an approve-and-run button. Set "destructive":true only when it removes data. ` +
    `If you only need to slice a read's output, pipe it into local tools instead: ssh ${host} 'journalctl -u x -n 500' | grep error.`
  );
}

export function parseSshHostsEnv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((h) => h.trim()).filter(Boolean);
}

function hasFlag(args: readonly string[], short: string[], long: string[]): boolean {
  return args.some((a) => {
    if (a.startsWith("--")) {
      const name = a.split("=", 1)[0]!;
      return name.length > 2 && long.some((l) => l.startsWith(name));
    }
    if (a.startsWith("-") && a.length > 1) return short.some((s) => a.slice(1).includes(s));
    return false;
  });
}

function positionals(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  const before = end < 0 ? args : args.slice(0, end);
  const after = end < 0 ? [] : args.slice(end + 1);
  return [...before.filter((a) => a === "-" || !a.startsWith("-")), ...after];
}

function hasRequiredShortFlag(args: readonly string[], letter: string, valueLetters: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return false;
    if (!a.startsWith("-") || a.startsWith("--") || a === "-") continue;
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (c === letter) return true;
      if (valueLetters.includes(c)) {
        if (j === a.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

function lookup<T>(table: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function leadingVerb(args: readonly string[], reads: Set<string>, groups: Record<string, Set<string>>): string | null {
  const [first, second] = args;
  if (first === undefined) return null;
  const group = lookup(groups, first);
  if (!group) return reads.has(first) ? first : null;
  return second !== undefined && group.has(second) ? second : null;
}

const any = () => true;
const subIn = (args: readonly string[], set: ReadonlySet<string>, allowNone = false) =>
  args[0] === undefined ? allowNone : set.has(args[0]);
const countedSampler = (args: readonly string[]) => positionals(args).length !== 1;

const SYSTEMCTL_READS = new Set([
  "status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files",
  "list-timers", "list-sockets", "list-dependencies", "show", "cat",
]);
const SYSTEMCTL_BARE_FLAGS = new Set(["--failed", "--all", "-a", "--no-pager", "--plain", "--no-legend"]);
const HOSTNAME_FLAGS = new Set([
  "-f", "-s", "-i", "-I", "-d", "-A", "--fqdn", "--short", "--long", "--all-ip-addresses", "--all-fqdns", "--domain", "--ip-address",
]);
const IP_OBJECTS = new Set(["addr", "address", "a", "link", "l", "route", "r", "neigh", "n", "rule", "ru"]);
const IP_READ_VERBS = new Set(["show", "list", "ls", "get"]);
const IP_LEADING_FLAGS = new Set([
  "-s", "-4", "-6", "-j", "-p", "-br", "-c", "-d", "-o", "-stats", "-brief", "-json", "-details", "-color", "-pretty",
]);
const STATUS_READS = new Set(["status", "show"]);
const ZPOOL_READS = new Set(["status", "list"]);
const ZFS_READS = new Set(["list", "get"]);
const PING_VALUE_LETTERS = "CceFiIlmMNpQsStTwW";
const TOP_VALUE_LETTERS = "dEenopUuw";
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const CRICTL_READS = new Set(["ps", "pods", "logs", "inspect", "inspectp", "inspecti", "images", "img", "stats", "statsp", "info", "version"]);
const DOCKER_READS = new Set(["ps", "logs", "inspect", "images", "version", "info", "top", "port", "diff", "history", "stats"]);
const DOCKER_GROUP_READS: Record<string, Set<string>> = {
  container: new Set(["ls", "ps", "list", "inspect", "logs", "top", "port", "diff"]),
  image: new Set(["ls", "list", "inspect", "history"]),
  volume: new Set(["ls", "list", "inspect"]),
  network: new Set(["ls", "list", "inspect"]),
  system: new Set(["df", "info"]),
  compose: new Set(["ps", "logs", "config", "images", "ls", "top", "version"]),
};

const KUBECTL_REMOTE_READS = new Set([
  "get", "describe", "logs", "top", "version", "api-resources", "api-versions", "cluster-info", "explain", "events",
]);
const KUBECTL_REMOTE_GROUP_READS: Record<string, Set<string>> = {
  ...KUBECTL_READONLY_SUBCOMMANDS,
  config: new Set(["view", "get-contexts", "current-context"]),
};
const REMOTE_KUBECTL_FLAGS: StrictFlags = { booleans: KUBECTL_GLOBAL_BOOLEANS, anyAssignment: false };

function dockerRead(args: readonly string[]): boolean {
  const verb = leadingVerb(args, DOCKER_READS, DOCKER_GROUP_READS);
  if (verb === null) return false;
  if (verb === "stats") return hasFlag(args, [], ["--no-stream"]);
  if (verb === "logs") return !hasFlag(args, ["f"], ["--follow"]);
  if (verb === "config") return !hasFlag(args, ["o"], ["--output"]);
  return true;
}

function crictlRead(args: readonly string[]): boolean {
  if (!subIn(args, CRICTL_READS)) return false;
  return args[0] !== "logs" || !hasFlag(args, ["f"], ["--follow"]);
}

function kubectlRead(args: readonly string[]): boolean {
  const { verb, sub } = findVerb(args, REMOTE_KUBECTL_FLAGS);
  if (verb === null) return false;
  const group = lookup(KUBECTL_REMOTE_GROUP_READS, verb);
  if (group ? sub === null || !group.has(sub) : !KUBECTL_REMOTE_READS.has(verb)) return false;
  if (verb === "cluster-info" && args.includes("dump")) return false;
  if (verb === "config" && hasFlag(args, [], ["--raw"])) return false;
  if (flagValues(args, ["--raw"]).some((path) => /secret/i.test(path))) return false;
  const cmd = ["kubectl", ...args].join(" ");
  return (
    classifyTier(cmd).tier === "read" &&
    !printsSecretValues(cmd) &&
    !hasFlag(args, ["w", "f"], ["--watch", "--watch-only", "--follow"])
  );
}

const REMOTE_READS: Record<string, (args: readonly string[]) => boolean> = {
  uptime: any, uname: any, whoami: any, id: any, nproc: any, lscpu: any, lsmem: any,
  lspci: any, lsusb: any, lsblk: any, findmnt: any, df: any, du: any, free: any,
  ps: any, pgrep: any, lsof: any, w: any, who: any, last: any, getent: any,
  ls: any, cat: any, zcat: any, head: any, wc: any, stat: any, readlink: any,
  realpath: any, grep: any, egrep: any, fgrep: any, cut: any, jq: any,
  md5sum: any, sha256sum: any, echo: any, pwd: any, nslookup: any, host: any, netstat: any,
  hostname: (a) => a.every((x) => HOSTNAME_FLAGS.has(x)),
  file: (a) => !hasFlag(a, ["C"], ["--compile"]),
  dig: (a) => !hasFlag(a, ["f"], []),
  mount: (a) => a.length === 0,
  date: (a) => a.every((x) => x.startsWith("+") || ["-u", "--utc", "-R", "-I", "--iso-8601"].includes(x)),
  vmstat: countedSampler,
  iostat: countedSampler,
  tail: (a) => !hasFlag(a, ["f", "F"], ["--follow", "--retry"]),
  sort: (a) => !hasFlag(a, ["o"], ["--output", "--compress-program"]),
  uniq: (a) => positionals(a).length <= 1,
  find: (a) => !a.some((x) => FIND_ACTIONS.has(x)),
  top: (a) => hasRequiredShortFlag(a, "b", TOP_VALUE_LETTERS) && hasRequiredShortFlag(a, "n", TOP_VALUE_LETTERS),
  ping: (a) => hasRequiredShortFlag(a, "c", PING_VALUE_LETTERS) && !hasFlag(a, ["f"], []),
  ss: (a) => !hasFlag(a, ["K", "D"], ["--kill", "--diag"]),
  ip: (a) => {
    let i = 0;
    while (i < a.length && IP_LEADING_FLAGS.has(a[i]!)) i++;
    const [obj, verb] = a.slice(i);
    return obj !== undefined && IP_OBJECTS.has(obj) && (verb === undefined || IP_READ_VERBS.has(verb));
  },
  journalctl: (a) =>
    !hasFlag(a, ["f"], [
      "--follow", "--vacuum-size", "--vacuum-time", "--vacuum-files", "--rotate", "--flush", "--sync",
      "--relinquish-var", "--smart-relinquish-var", "--update-catalog", "--setup-keys", "--cursor-file",
    ]),
  systemctl: (a) => subIn(a, SYSTEMCTL_READS) || a.every((x) => SYSTEMCTL_BARE_FLAGS.has(x)),
  timedatectl: (a) => subIn(a, STATUS_READS, true),
  hostnamectl: (a) => subIn(a, STATUS_READS, true),
  dmesg: (a) =>
    !hasFlag(a, ["c", "C", "D", "E", "n", "w", "W"], [
      "--clear", "--read-clear", "--console-off", "--console-on", "--console-level", "--follow", "--follow-new",
    ]),
  docker: dockerRead,
  crictl: crictlRead,
  kubectl: kubectlRead,
  k3s: (a) =>
    a[0] === "--version" || a[0] === "-v" || a[0] === "check-config" ||
    (a[0] === "kubectl" && kubectlRead(a.slice(1))) ||
    (a[0] === "crictl" && crictlRead(a.slice(1))),
  zpool: (a) => subIn(a, ZPOOL_READS) && !hasFlag(a, ["c"], []),
  zfs: (a) => subIn(a, ZFS_READS),
  smartctl: (a) => !hasFlag(a, ["t", "s", "o", "S", "X"], ["--test", "--smart", "--offlineauto", "--saveauto", "--abort", "--set"]),
};

const SAFE_OUTPUT_OPS = new Set([">", ">>", ">|", "&>", "&>>"]);

function redirectIsSafe({ op, target }: ShellSegment["redirects"][number]): boolean {
  if (target === null) return false;
  if (op === "<") return true;
  if (op === ">&" || op === "<&") return /^(\d+|-)$/.test(target);
  return SAFE_OUTPUT_OPS.has(op) && target === "/dev/null";
}

const READ_HEAD_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

function segmentIsRead(seg: ShellSegment, depth: number): boolean {
  if (!seg.redirects.every(redirectIsSafe)) return false;
  let words = seg.words;
  if (words[0] === "sudo") {
    words = words.slice(1);
    while (words[0] === "-n") words = words.slice(1);
  }
  const [head, ...args] = words;
  if (head === undefined || ASSIGNMENT.test(head)) return false;
  const { dir, name } = splitHead(head);
  if (dir !== null && !READ_HEAD_DIRS.has(dir)) return false;
  if (name === "sh" || name === "bash") {
    return args.length === 2 && args[0] === "-c" && remoteIsRead(args[1]!, depth + 1);
  }
  const rule = lookup(REMOTE_READS, name);
  return rule ? rule(args) : false;
}

function remoteIsRead(command: string, depth = 0): boolean {
  if (depth > 3 || /[()]/.test(command)) return false;
  const parsed = parseShell(command);
  if (!parsed || parsed.substitution) return false;
  return parsed.segments.length > 0 && parsed.segments.every((s) => segmentIsRead(s, depth));
}

function optionAllowed(value: string): boolean {
  const key = value.split(/[=\s]/, 1)[0]!.toLowerCase();
  return SSH_ALLOWED_OPTIONS.has(key);
}

export function classifySsh(argv: readonly string[], enabledHosts: readonly string[]): SshVerdict {
  const deny = (reason: string): SshVerdict => ({ decision: "deny", reason });
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    for (let j = 1; j < a.length; j++) {
      const f = a[j]!;
      if (SSH_DENY_FLAGS.has(f)) return deny(f === "N" || f === "t" ? INTERACTIVE_HINT : `ssh -${f} isn't allowed from chat.`);
      if (SSH_VALUE_FLAGS.has(f)) {
        const value = a.slice(j + 1) || argv[++i];
        if (value === undefined) return deny(`ssh -${f} is missing its value.`);
        if (f === "o" && !optionAllowed(value)) return deny(`ssh -o ${value} isn't allowed from chat.`);
        break;
      }
      if (!SSH_BOOL_FLAGS.has(f)) return deny(`Unknown ssh option -${f}.`);
    }
  }
  const dest = argv[i];
  if (dest === undefined) return deny(INTERACTIVE_HINT);
  if (dest.includes("://")) return deny("Use the host's alias from ~/.ssh/config, not an ssh:// URL.");
  const at = dest.lastIndexOf("@");
  if (at >= 0 && !/^[A-Za-z0-9._-]+$/.test(dest.slice(0, at))) {
    return deny("The user part of an SSH destination can only contain letters, digits, dots, underscores and hyphens.");
  }
  const host = dest.slice(at + 1);
  if (!enabledHosts.includes(host)) return deny(hostHint(host, enabledHosts));
  const remote = argv.slice(i + 1).join(" ").trim();
  if (!remote) return deny(INTERACTIVE_HINT);
  return remoteIsRead(remote)
    ? { decision: "read", reason: `read-only command on ${host}` }
    : { decision: "approve", reason: approvalHint(host) };
}

export function classifyShellSsh(parsed: ParsedShell, enabledHosts: readonly string[]): ShellSshVerdict {
  if (parsed.substitution) return { decision: "deny", reason: SSH_INDIRECT_HINT };
  const local: string[] = [];
  for (const seg of parsed.segments) {
    const [head, ...rest] = seg.words;
    if (head === "ssh") {
      const v = classifySsh(rest, enabledHosts);
      if (v.decision !== "read") return { decision: "deny", reason: v.reason };
      continue;
    }
    if (seg.words.some((w) => SSH_FAMILY.test(w) || w.includes("$"))) {
      return { decision: "deny", reason: SSH_INDIRECT_HINT };
    }
    local.push(seg.words.join(" "));
  }
  return { decision: "allow", reason: "read-only ssh", local: local.join(" ; ") };
}
