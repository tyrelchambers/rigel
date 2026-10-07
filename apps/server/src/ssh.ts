import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { SSH_BATCH_ARGS } from "@rigel/k8s";
import { summarizeActionDetail } from "@rigel/k8s/src/aiActionLedger";
import { runProcess, type RunResult } from "@rigel/k8s/src/run";

export interface SshHost {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  enabled: boolean;
}

const SSH_DIR = join(homedir(), ".ssh");
export const SSH_ACTION_TIMEOUT_MS = 30 * 60_000;
const ACTION_MAX_OUTPUT = 10 * 1024 * 1024;

function enabledFile(): string {
  const dir = process.env.RIGEL_USER_DATA_DIR;
  return dir ? join(dir, "ssh-hosts.json") : join(homedir(), ".rigel", "ssh-hosts.json");
}

export function parseSshConfig(text: string): { aliases: string[]; includes: string[] } {
  const aliases: string[] = [];
  const includes: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.+)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const values: string[] = [];
    for (const [, quoted, bare] of m[2]!.matchAll(/"([^"]*)"|(\S+)/g)) {
      if (bare?.startsWith("#")) break;
      values.push(quoted ?? bare!);
    }
    if (key === "host") aliases.push(...values.filter((v) => !/[*?!]/.test(v)));
    else if (key === "include") includes.push(...values);
  }
  return { aliases, includes };
}

export async function listSshConfigAliases(configPath = join(SSH_DIR, "config"), sshDir = SSH_DIR): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = async (path: string, depth: number) => {
    if (depth > 5 || seen.has(path)) return;
    seen.add(path);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return;
    }
    const { aliases, includes } = parseSshConfig(text);
    for (const a of aliases) if (!out.includes(a)) out.push(a);
    for (const inc of includes) {
      const expanded = inc.startsWith("~/") ? join(homedir(), inc.slice(2)) : isAbsolute(inc) ? inc : join(sshDir, inc);
      for await (const match of glob(expanded)) await visit(match, depth + 1);
    }
  };
  await visit(configPath, 0);
  return out;
}

export async function readEnabledSshHosts(known: readonly string[], file = enabledFile()): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { enabled?: unknown };
    const list = Array.isArray(parsed.enabled) ? parsed.enabled.filter((h): h is string => typeof h === "string") : [];
    return list.filter((h) => known.includes(h));
  } catch {
    return [];
  }
}

export async function setEnabledSshHosts(enabled: readonly string[], file = enabledFile()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ enabled }, null, 2));
}

export async function enabledSshHosts(): Promise<string[]> {
  return readEnabledSshHosts(await listSshConfigAliases());
}

async function resolvedHost(alias: string): Promise<Pick<SshHost, "hostName" | "user" | "port">> {
  const { stdout } = await runProcess("ssh", ["-G", "--", alias], { timeout: 5_000 });
  const get = (k: string) => stdout.match(new RegExp(`^${k} (.+)$`, "m"))?.[1] ?? "";
  return { hostName: get("hostname"), user: get("user"), port: get("port") };
}

export async function listSshHosts(): Promise<SshHost[]> {
  const aliases = await listSshConfigAliases();
  const enabled = await readEnabledSshHosts(aliases);
  return Promise.all(
    aliases.map(async (alias) => ({ alias, ...(await resolvedHost(alias)), enabled: enabled.includes(alias) })),
  );
}

export function sshActionArgv(host: string, command: string): string[] {
  return ["ssh", ...SSH_BATCH_ARGS, "--", host, command];
}

export function validateSshAction(
  body: { host?: string; command?: string },
  enabledHosts: readonly string[],
): { host: string; command: string } | { error: string } {
  const host = body.host?.trim() ?? "";
  const command = body.command?.trim() ?? "";
  if (!host || !command) return { error: "sshCommand needs host and command" };
  if (command.startsWith("-")) return { error: "sshCommand command can't start with -" };
  if (!enabledHosts.includes(host)) return { error: `${host} isn't enabled in Settings > AI agents > SSH hosts` };
  return { host, command };
}

export function runSshAction(host: string, command: string): Promise<RunResult> {
  const [bin, ...args] = sshActionArgv(host, command);
  return runProcess(bin!, args, { timeout: SSH_ACTION_TIMEOUT_MS, maxOutput: ACTION_MAX_OUTPUT });
}

export function sshActionDetail(code: number, stdout: string, stderr: string): string {
  const outcome = code === 0 ? "success" : "failure";
  return [`exit ${code}`, summarizeActionDetail(outcome, stdout, stderr)].filter(Boolean).join(": ");
}
