// The voice agent's only read path. Argv is built from typed parameters, then
// the assembled command is re-checked against the SHARED chat classifier
// (classifyCommand) before spawning, so this path can never drift from the chat
// policy: anything the classifier would deny is refused here too. The NotFound
// fallback is held to the same rule: it builds its argv with buildReadArgv and
// asserts it with assertRead, and it can only ever run once per call.
import { spawn } from "node:child_process";
import { classifyCommand } from "@rigel/k8s";

export type ReadVerb = "get" | "describe" | "logs" | "top" | "events";

export interface ReadArgs {
  verb: ReadVerb;
  kind?: string;
  name?: string;
  namespace?: string;
  container?: string;
  tail?: number;
}

export interface ReadChild {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null) => void): unknown;
}

export type SpawnRead = (command: string, args: string[]) => ReadChild;

const OUTPUT_CAP = 8192;

const spawnKubectl: SpawnRead = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

export function buildReadArgv(a: ReadArgs): string[] {
  const ns = a.namespace ? ["-n", a.namespace] : [];
  const nsOrAll = a.namespace ? ["-n", a.namespace] : ["-A"];
  switch (a.verb) {
    case "get":
      return ["get", a.kind ?? "pods", ...(a.name ? [a.name, ...ns] : nsOrAll), "-o", "wide"];
    case "describe":
      if (!a.kind || !a.name) throw new Error("describe needs kind and name");
      return ["describe", a.kind, a.name, ...ns];
    case "logs":
      if (!a.name) throw new Error("logs needs a name (pod or deploy/<name>)");
      return [
        "logs",
        a.name,
        ...(a.container ? ["-c", a.container] : []),
        "--tail",
        String(a.tail ?? 100),
        ...ns,
      ];
    case "top":
      return a.kind === "nodes" ? ["top", "nodes"] : ["top", "pods", ...nsOrAll];
    case "events":
      return ["events", ...nsOrAll];
    default:
      throw new Error(`unsupported read verb: ${String(a.verb)}`);
  }
}

export function assertRead(argv: string[], context: string | null): void {
  const cmd = ["kubectl", ...(context ? ["--context", context] : []), ...argv].join(" ");
  const verdict = classifyCommand(cmd, context);
  if (verdict.decision !== "allow") throw new Error(`refused: ${verdict.reason}`);
}

const NOT_FOUND = /notfound|not found/i;
const MAX_NEAR = 5;

/** The first column of a `kubectl get -o wide` listing, header row dropped. */
function listedNames(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name.length > 0 && name !== "NAME" && name !== "NAMESPACE");
}

/**
 * Names a speaker could have meant by `wanted`: one contains the other, either
 * as written or with hyphens squashed out the way speech-to-text renders them.
 * Shortest first, so the least-padded candidate leads.
 */
function nearNames(wanted: string, names: string[]): string[] {
  const squash = (s: string) => s.toLowerCase().replace(/-/g, "");
  const w = squash(wanted);
  return names
    .filter((name) => {
      const n = squash(name);
      return n.includes(w) || w.includes(n);
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, MAX_NEAR);
}

/** Spawn one kubectl read and cap what it printed. Never spawns more than once. */
function spawnOnce(
  argv: string[],
  context: string | null,
  spawnFn: SpawnRead,
): Promise<{ ok: boolean; text: string }> {
  const full = [...(context ? ["--context", context] : []), ...argv];
  return new Promise((resolve) => {
    const child = spawnFn("kubectl", full);
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (out += b.toString("utf8")));
    child.on("error", (err) => resolve({ ok: false, text: `kubectl failed to start: ${err.message}` }));
    child.on("close", (code) => {
      const capped = out.length > OUTPUT_CAP ? `${out.slice(0, OUTPUT_CAP)}\n[truncated]` : out;
      if (code === 0) resolve({ ok: true, text: capped || "(no output)" });
      else resolve({ ok: false, text: `kubectl exited ${code}:\n${capped}` });
    });
  });
}

/**
 * A named read that missed is recoverable inside the same turn: list the kind
 * and hand back what the speaker plausibly meant, so the model retries or names
 * the alternatives instead of dead-ending on "there is no such resource".
 */
async function recoverMiss(a: ReadArgs, context: string | null, spawnFn: SpawnRead): Promise<string> {
  const where = a.namespace ? `namespace ${a.namespace}` : "any namespace";
  const miss = `No ${a.kind} named "${a.name}" in ${where}.`;
  const argv = buildReadArgv({ verb: "get", kind: a.kind, namespace: a.namespace });
  assertRead(argv, context);
  const listing = await spawnOnce(argv, context, spawnFn);
  if (!listing.ok) return `${miss} Listing them failed too:\n${listing.text}`;

  const names = listedNames(listing.text);
  const near = nearNames(a.name ?? "", names);
  const count = `There are ${names.length} ${a.kind} in ${where}.`;
  if (near.length > 0) {
    return [
      `${miss} ${count} Closest by name: ${near.join(", ")}.`,
      "Re-read one by its full name, or tell the user every name listed here.",
    ].join(" ");
  }
  return `${miss} ${count} Nothing is close by name. Full listing:\n${listing.text}`;
}

/** Build, policy-check, spawn, and cap the output of one kubectl read. */
export async function runRead(a: ReadArgs, context: string | null, spawnFn: SpawnRead = spawnKubectl): Promise<string> {
  const argv = buildReadArgv(a);
  assertRead(argv, context);
  const res = await spawnOnce(argv, context, spawnFn);
  const missed = !res.ok && NOT_FOUND.test(res.text);
  if (!missed || !a.kind || !a.name || (a.verb !== "get" && a.verb !== "describe")) return res.text;
  return recoverMiss(a, context, spawnFn);
}
