import { execFile } from "node:child_process";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { SSH_BATCH_ARGS } from "@rigel/k8s";

export interface SshHost {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  enabled: boolean;
}

export interface SshRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SSH_DIR = join(homedir(), ".ssh");
const ACTION_TIMEOUT_MS = 120_000;

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
    const values = m[2]!.split(/\s+/).filter(Boolean);
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

function run(argv: string[], timeout: number): Promise<SshRunResult> {
  return new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && !stderr ? err.message : "") });
    });
  });
}

async function resolvedHost(alias: string): Promise<Pick<SshHost, "hostName" | "user" | "port">> {
  const { stdout } = await run(["ssh", "-G", "--", alias], 5_000);
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

export function runSshAction(host: string, command: string): Promise<SshRunResult> {
  return run(sshActionArgv(host, command), ACTION_TIMEOUT_MS);
}
