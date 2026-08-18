// The voice agent's only read path. Argv is built from typed parameters, then
// the assembled command is re-checked against the SHARED chat classifier
// (classifyCommand) before spawning, so this path can never drift from the chat
// policy: anything the classifier would deny is refused here too.
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

/** Build, policy-check, spawn, and cap the output of one kubectl read. */
export async function runRead(a: ReadArgs, context: string | null, spawnFn: SpawnRead = spawnKubectl): Promise<string> {
  const argv = buildReadArgv(a);
  assertRead(argv, context);
  const full = [...(context ? ["--context", context] : []), ...argv];
  return new Promise((resolve) => {
    const child = spawnFn("kubectl", full);
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (out += b.toString("utf8")));
    child.on("error", (err) => resolve(`kubectl failed to start: ${err.message}`));
    child.on("close", (code) => {
      const capped = out.length > OUTPUT_CAP ? `${out.slice(0, OUTPUT_CAP)}\n[truncated]` : out;
      resolve(code === 0 ? capped || "(no output)" : `kubectl exited ${code}:\n${capped}`);
    });
  });
}
