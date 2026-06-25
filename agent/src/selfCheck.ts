import { spawn } from "node:child_process";
import type { ProviderId } from "./providers/types.js";

/** Presence of each provider CLI on PATH. */
export type CliPresence = Record<ProviderId, boolean>;

const PROVIDER_BINS: Record<ProviderId, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

/** True iff `name` resolves on the current PATH (via `command -v`). */
export function checkCli(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", `command -v ${name}`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

/** Probe all four provider CLIs. Never throws — an absent CLI is just false. */
export async function runSelfCheck(): Promise<CliPresence> {
  const ids = Object.keys(PROVIDER_BINS) as ProviderId[];
  const results = await Promise.all(ids.map((id) => checkCli(PROVIDER_BINS[id]!)));
  const presence = {} as CliPresence;
  ids.forEach((id, i) => (presence[id] = results[i]!));
  return presence;
}

/** One-line human-readable summary for the startup log. */
export function formatSelfCheck(presence: CliPresence): string {
  return (Object.keys(presence) as ProviderId[])
    .map((id) => `${id}: ${presence[id] ? "present" : "absent"}`)
    .join(", ");
}
