import { kubectl } from "./kubectl.js";

/**
 * Configuration is split in two:
 *  - process env: deploy-time defaults baked into the Deployment manifest.
 *  - the `assistant-config` ConfigMap: human/Rigel-editable runtime knobs,
 *    crucially the `enabled` kill-switch. It is read every loop so flipping it
 *    halts the agent within one poll interval. The agent never writes it.
 */

export interface Config {
  workerModel: string;
  supervisorModel: string;
  pollIntervalMs: number;
  spendCapUsd: number;
  maxPerResourcePerHour: number;
  maxPerNight: number;
  maxAttemptsPerIncident: number;
  windowMs: number;
  /** Empty = all namespaces. */
  namespaces: string[];
  /** Consecutive polls an incident must persist before the agent acts —
   * debounces transient states like a mid-rollout deployment. */
  confirmPolls: number;
  /** Max Worker (diagnosis) model calls in flight at once when several incidents
   * are confirmed in one tick. Kept small to overlap latency without hammering
   * the Claude subscription rate limit. */
  maxConcurrentDiagnoses: number;
  stateConfigMap: string;
  configConfigMap: string;
  backupsConfigMap: string;
  stateNamespace: string;
  auditMaxEntries: number;
  maxBackups: number;
  /** TTL backstop for queued suggestions we can't actively re-validate. */
  queueTtlMs: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number: ${raw}`);
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

export function loadConfig(): Config {
  return {
    workerModel: str("WORKER_MODEL", "claude-sonnet-4-6"),
    supervisorModel: str("SUPERVISOR_MODEL", "claude-opus-4-8"),
    pollIntervalMs: num("POLL_INTERVAL_MS", 30_000),
    spendCapUsd: num("SPEND_CAP_USD", 50),
    maxPerResourcePerHour: num("MAX_PER_RESOURCE_PER_HOUR", 3),
    maxPerNight: num("MAX_PER_NIGHT", 20),
    maxAttemptsPerIncident: num("MAX_ATTEMPTS_PER_INCIDENT", 3),
    windowMs: num("WINDOW_MS", 24 * 3_600_000),
    namespaces: str("NAMESPACES", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    confirmPolls: num("CONFIRM_POLLS", 2),
    maxConcurrentDiagnoses: Math.max(1, num("MAX_CONCURRENT_DIAGNOSES", 3)),
    stateConfigMap: str("STATE_CONFIGMAP", "assistant-state"),
    configConfigMap: str("CONFIG_CONFIGMAP", "assistant-config"),
    backupsConfigMap: str("BACKUPS_CONFIGMAP", "assistant-backups"),
    stateNamespace: str("STATE_NAMESPACE", "default"),
    auditMaxEntries: num("AUDIT_MAX_ENTRIES", 200),
    maxBackups: num("MAX_BACKUPS", 50),
    queueTtlMs: num("QUEUE_TTL_HOURS", 48) * 3_600_000,
  };
}

/** Read the kill-switch. Fail-closed: if the config ConfigMap is missing or
 * unreadable, the agent is considered DISABLED and does nothing. */
export async function isEnabled(cfg: Config): Promise<boolean> {
  const res = await kubectl([
    "get",
    "configmap",
    cfg.configConfigMap,
    "-n",
    cfg.stateNamespace,
    "-o",
    "json",
  ]);
  if (res.code !== 0) return false;
  try {
    const cm = JSON.parse(res.stdout) as { data?: Record<string, string> };
    return cm.data?.enabled !== "false";
  } catch {
    return false;
  }
}
