import { classifyTier, printsSecretValues } from "./commandPolicy";
import { ShellParseError, splitSegments, tokenizeShell, type ShellSegment } from "./shellWords";

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

export const SSH_FAMILY = /(?:^|[\s;|&(`'"\/=])(?:ssh|scp|sftp|sshfs|sshpass|autossh|mosh|rsync)(?=$|[\s;|&)`'"])/;

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
  "Do NOT retry a variation; run it directly in that form.";

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
    if (a.startsWith("--")) return long.some((l) => a === l || a.startsWith(`${l}=`));
    if (a.startsWith("-") && a.length > 1) return short.some((s) => a.slice(1).includes(s));
    return false;
  });
}

const positionals = (args: readonly string[]) => args.filter((a) => !a.startsWith("-"));
const any = () => true;
const noPositional = (args: readonly string[]) => positionals(args).length === 0;
const subIn = (set: Set<string>, allowNone = false) => (args: readonly string[]) => {
  const sub = positionals(args)[0];
  return sub === undefined ? allowNone : set.has(sub);
};
const countedSampler = (args: readonly string[]) => positionals(args).length !== 1;

const SYSTEMCTL_READS = new Set([
  "status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files",
  "list-timers", "list-sockets", "list-dependencies", "show", "cat",
]);
const IP_OBJECTS = new Set(["addr", "address", "a", "link", "l", "route", "r", "neigh", "n", "rule", "ru"]);
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const CRICTL_READS = new Set(["ps", "pods", "logs", "inspect", "inspectp", "inspecti", "images", "img", "stats", "statsp", "info", "version"]);
const DOCKER_READS = new Set(["ps", "logs", "inspect", "images", "version", "info", "top", "port", "diff", "history"]);
const DOCKER_GROUP_READS: Record<string, Set<string>> = {
  container: new Set(["ls", "ps", "list", "inspect", "logs", "top", "port", "diff"]),
  image: new Set(["ls", "list", "inspect", "history"]),
  volume: new Set(["ls", "list", "inspect"]),
  network: new Set(["ls", "list", "inspect"]),
  system: new Set(["df", "info"]),
  compose: new Set(["ps", "logs", "config", "images", "ls", "top", "version"]),
};

function dockerRead(args: readonly string[]): boolean {
  const [sub, sub2] = positionals(args);
  if (sub === undefined) return false;
  if (sub === "stats") return hasFlag(args, [], ["--no-stream"]);
  const group = DOCKER_GROUP_READS[sub];
  const verb = group ? sub2 : sub;
  if (verb === undefined || !(group ? group.has(verb) : DOCKER_READS.has(verb))) return false;
  return verb !== "logs" || !hasFlag(args, ["f"], ["--follow"]);
}

function crictlRead(args: readonly string[]): boolean {
  const sub = positionals(args)[0];
  if (sub === undefined || !CRICTL_READS.has(sub)) return false;
  return sub !== "logs" || !hasFlag(args, ["f"], ["--follow"]);
}

function kubectlRead(args: readonly string[]): boolean {
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
  ls: any, cat: any, zcat: any, head: any, wc: any, stat: any, file: any, readlink: any,
  realpath: any, grep: any, egrep: any, fgrep: any, zgrep: any, cut: any, jq: any,
  md5sum: any, sha256sum: any, echo: any, pwd: any, nslookup: any, host: any, netstat: any,
  hostname: noPositional,
  dig: (a) => !hasFlag(a, ["f"], []),
  mount: (a) => a.length === 0,
  date: (a) => a.every((x) => x.startsWith("+") || ["-u", "--utc", "-R", "-I", "--iso-8601"].includes(x)),
  vmstat: countedSampler,
  iostat: countedSampler,
  tail: (a) => !hasFlag(a, ["f", "F"], ["--follow", "--retry"]),
  sort: (a) => !hasFlag(a, ["o"], ["--output", "--compress-program"]),
  uniq: (a) => positionals(a).length <= 1,
  find: (a) => !a.some((x) => FIND_ACTIONS.has(x)),
  top: (a) => hasFlag(a, ["b"], []) && hasFlag(a, ["n"], []),
  ping: (a) => hasFlag(a, ["c"], ["--count"]),
  ss: (a) => !hasFlag(a, ["K"], ["--kill"]),
  ip: (a) => {
    const [obj, verb] = positionals(a);
    return obj !== undefined && IP_OBJECTS.has(obj) && (verb === undefined || ["show", "list", "ls", "get"].includes(verb));
  },
  journalctl: (a) =>
    !hasFlag(a, ["f"], [
      "--follow", "--vacuum-size", "--vacuum-time", "--vacuum-files", "--rotate", "--flush", "--sync",
      "--relinquish-var", "--smart-relinquish-var", "--update-catalog", "--setup-keys",
    ]),
  systemctl: subIn(SYSTEMCTL_READS, true),
  timedatectl: subIn(new Set(["status", "show"]), true),
  hostnamectl: subIn(new Set(["status", "show"]), true),
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
  zpool: subIn(new Set(["status", "list"])),
  zfs: subIn(new Set(["list", "get"])),
  smartctl: (a) => !hasFlag(a, ["t", "s", "o", "S", "X"], ["--test", "--smart", "--offlineauto", "--saveauto", "--abort", "--set"]),
};

const SAFE_OUTPUT_OPS = new Set([">", ">>", ">|", "&>", "&>>"]);

function redirectIsSafe({ op, target }: ShellSegment["redirects"][number]): boolean {
  if (target === null) return false;
  if (op === "<") return true;
  if (op === ">&" || op === "<&") return /^(\d+|-)$/.test(target);
  return SAFE_OUTPUT_OPS.has(op) && target === "/dev/null";
}

function segmentIsRead(seg: ShellSegment, depth: number): boolean {
  if (!seg.redirects.every(redirectIsSafe)) return false;
  let words = seg.words;
  if (words[0] === "sudo") {
    words = words.slice(1);
    while (words[0] === "-n") words = words.slice(1);
  }
  const [head, ...args] = words;
  if (head === undefined || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return false;
  const name = head.slice(head.lastIndexOf("/") + 1);
  if (name === "sh" || name === "bash") {
    return args.length === 2 && args[0] === "-c" && remoteIsRead(args[1]!, depth + 1);
  }
  const rule = REMOTE_READS[name];
  return rule ? rule(args) : false;
}

function remoteIsRead(command: string, depth = 0): boolean {
  if (depth > 3) return false;
  let parsed;
  try {
    parsed = tokenizeShell(command);
  } catch {
    return false;
  }
  if (parsed.substitution) return false;
  const segments = splitSegments(parsed.tokens);
  return segments.length > 0 && segments.every((s) => segmentIsRead(s, depth));
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
      if (SSH_VALUE_FLAGS.has(f)) {
        const value = a.slice(j + 1) || argv[++i];
        if (value === undefined) return deny(`ssh -${f} is missing its value.`);
        if (SSH_DENY_FLAGS.has(f)) return deny(f === "N" || f === "t" ? INTERACTIVE_HINT : `ssh -${f} isn't allowed from chat.`);
        if (f === "o" && !optionAllowed(value)) return deny(`ssh -o ${value} isn't allowed from chat.`);
        break;
      }
      if (SSH_DENY_FLAGS.has(f)) return deny(f === "N" || f === "t" ? INTERACTIVE_HINT : `ssh -${f} isn't allowed from chat.`);
      if (!SSH_BOOL_FLAGS.has(f)) return deny(`Unknown ssh option -${f}.`);
    }
  }
  const dest = argv[i];
  if (dest === undefined) return deny(INTERACTIVE_HINT);
  if (dest.includes("://")) return deny("Use the host's alias from ~/.ssh/config, not an ssh:// URL.");
  const host = dest.slice(dest.lastIndexOf("@") + 1);
  if (!enabledHosts.includes(host)) return deny(hostHint(host, enabledHosts));
  const remote = argv.slice(i + 1).join(" ").trim();
  if (!remote) return deny(INTERACTIVE_HINT);
  return remoteIsRead(remote)
    ? { decision: "read", reason: `read-only command on ${host}` }
    : { decision: "approve", reason: approvalHint(host) };
}

export function classifyShellSsh(command: string, enabledHosts: readonly string[]): ShellSshVerdict {
  let parsed;
  try {
    parsed = tokenizeShell(command);
  } catch (err) {
    if (err instanceof ShellParseError) return { decision: "deny", reason: SSH_INDIRECT_HINT };
    throw err;
  }
  if (parsed.substitution) return { decision: "deny", reason: SSH_INDIRECT_HINT };
  const local: string[] = [];
  for (const seg of splitSegments(parsed.tokens)) {
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
