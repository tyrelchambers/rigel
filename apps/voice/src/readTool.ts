// The voice agent's only read path: literal kubectl arguments, checked against
// the SHARED chat classifier (classifyCommand) before spawning, so this path
// can never drift from the chat policy. Anything the classifier would deny is
// refused here too, and the NotFound fallback is held to the same rule: it
// asserts its own argv and can only ever run once per call.
//
// The parameters used to be a closed {verb, kind, name} set that hard-coded
// `-o wide` on every get, which meant the agent could only ever see the cluster
// as a TABLE. Asked to copy a workload's resources into Git, it could not read
// the YAML it needed to write, and there was no way for it to say so. The guard
// belongs on what a command DOES, which classifyCommand already decides, not on
// the shape the request is allowed to take.
//
// Secret values are removed from every read before the model sees them. See
// secretRedaction.ts: the decision is to redact rather than refuse, so the
// agent still sees that a Secret exists, its keys and its type.
import { spawn } from "node:child_process";
import { classifyCommand } from "@rigel/k8s";
import { redactSecretValues, refusesForSecretValues } from "@rigel/k8s/src/secretRedaction";

export interface ReadChild {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null) => void): unknown;
}

export type SpawnRead = (command: string, args: string[]) => ReadChild;

const OUTPUT_CAP = 8192;

/**
 * What a cut-off read says for itself. A bare "[truncated]" leaves the model
 * holding half a YAML object with no idea how much is missing or what to do
 * about it, which is how a read of every Service in a busy namespace becomes a
 * dead end. Naming the size and the ways to narrow lets it finish the job:
 * chaining reads (a workload's selector, then the Service matching it, then the
 * Ingress behind that) is exactly the reasoning this cap was silently blocking.
 */
function truncationNote(total: number): string {
  return [
    `[truncated: ${total} characters, ${OUTPUT_CAP} shown. This output is incomplete and may end mid-object.`,
    "Narrow it and read again: name one resource, use -o custom-columns to pick only the fields you need",
    "(e.g. -o custom-columns=NAME:.metadata.name,SELECTOR:.spec.selector),",
    "add --field-selector, or select with -l once you know the labels.]",
  ].join(" ");
}

const spawnKubectl: SpawnRead = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

export function assertRead(argv: string[], context: string | null): void {
  const cmd = ["kubectl", ...(context ? ["--context", context] : []), ...argv].join(" ");
  const verdict = classifyCommand(cmd, context);
  if (verdict.decision !== "allow") throw new Error(`refused: ${verdict.reason}`);
}

const NOT_FOUND = /notfound|not found/i;

/**
 * A `get <kind> <name>` shaped read, or null. The NotFound recovery exists for
 * speech-to-text name mangling, which broad argv does not fix, so it is kept and
 * keyed off the argv instead of off typed fields.
 */
export function namedGet(args: string[]): { kind: string; name: string; namespace?: string } | null {
  const positional = args.filter((a) => !a.startsWith("-"));
  const flagged = (flag: string) => {
    const i = args.findIndex((a) => a === flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const [verb, kind, name] = positional;
  if ((verb !== "get" && verb !== "describe") || !kind || !name) return null;
  // A slash form names one resource in one argument; there is no separate name
  // to have misheard, so there is nothing to recover toward.
  if (kind.includes("/")) return null;
  return { kind, name, namespace: flagged("-n") ?? flagged("--namespace") };
}
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
      const safe = redactSecretValues(out);
      const capped = safe.length > OUTPUT_CAP ? `${safe.slice(0, OUTPUT_CAP)}\n${truncationNote(safe.length)}` : safe;
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
async function recoverMiss(
  target: { kind: string; name: string; namespace?: string },
  context: string | null,
  spawnFn: SpawnRead,
): Promise<string> {
  const where = target.namespace ? `namespace ${target.namespace}` : "any namespace";
  const miss = `No ${target.kind} named "${target.name}" in ${where}.`;
  const argv = ["get", target.kind, ...(target.namespace ? ["-n", target.namespace] : ["-A"]), "-o", "wide"];
  assertRead(argv, context);
  const listing = await spawnOnce(argv, context, spawnFn);
  if (!listing.ok) return `${miss} Listing them failed too:\n${listing.text}`;

  const names = listedNames(listing.text);
  const near = nearNames(target.name, names);
  const count = `There are ${names.length} ${target.kind} in ${where}.`;
  if (near.length > 0) {
    return [
      `${miss} ${count} Closest by name: ${near.join(", ")}.`,
      "Re-read one by its full name, or tell the user every name listed here.",
    ].join(" ");
  }
  return `${miss} ${count} Nothing is close by name. Full listing:\n${listing.text}`;
}

/**
 * Split arguments a model jammed together. Field-tested: it repeatedly sent
 * ["get", "deployment,svc,hpa -o", "yaml"], with the flag INSIDE the
 * resource-type argument, then "fixed" it by dropping a resource type and
 * failing again, four calls in a row, because the error names the mangled type
 * and not the space. A kubectl argument never legitimately contains a space
 * followed by a flag, so this splits exactly that and leaves everything else
 * (jsonpath expressions, selectors, custom-columns) untouched.
 */
export function splitJoinedArgs(args: string[]): string[] {
  return args.flatMap((arg) => (/\S\s+-{1,2}\S/.test(arg) ? arg.split(/\s+/).filter(Boolean) : [arg]));
}

/** Policy-check, spawn, redact and cap the output of one kubectl read. */
export async function runRead(
  args: string[],
  context: string | null,
  spawnFn: SpawnRead = spawnKubectl,
): Promise<string> {
  if (args.length === 0) throw new Error("refused: a read needs kubectl arguments");
  args = splitJoinedArgs(args);
  assertRead(args, context);
  // The one case redaction cannot cover: the output would be the bare value
  // with no structure left to filter, so it is refused before it runs.
  if (refusesForSecretValues(args)) {
    throw new Error(
      "refused: that would print a Secret's values. Read the Secret with -o yaml instead, which gives you its name, type and keys.",
    );
  }
  const res = await spawnOnce(args, context, spawnFn);
  const target = namedGet(args);
  if (!res.ok && NOT_FOUND.test(res.text) && target) return recoverMiss(target, context, spawnFn);
  return res.text;
}
