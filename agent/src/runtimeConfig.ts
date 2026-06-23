import { kubectl } from "./kubectl.js";
import type { Config } from "./config.js";
import { parseAlertRules, type AlertRule } from "./alerts.js";
import type { ProviderId, RoleSelection } from "./providers/types.js";

export interface OperationalLimits {
  pollIntervalMs: number;
  maxPerResourcePerHour: number;
  maxPerNight: number;
  maxAttemptsPerIncident: number;
  confirmPolls: number;
  namespaces: string[];
}

const PROVIDERS = new Set<ProviderId>(["claude", "codex", "gemini", "opencode"]);

/**
 * Live, human/Rigel-editable control surface, read from the `assistant-config`
 * ConfigMap every poll. Separate from the deploy-time env config. Lets the
 * operator flip the kill-switch, silence noisy incidents, set the autonomy mode,
 * and point at a notification webhook — all without redeploying.
 */

export type AutonomyMode = "auto" | "advisory" | "window";

export interface TimeWindow {
  startMin: number; // minutes-of-day
  endMin: number;
}

export interface RuntimeConfig {
  enabled: boolean;
  mode: AutonomyMode;
  window?: TimeWindow;
  silenced: Set<string>;
  webhookUrl?: string;
  /** Self-hosted signal-cli-rest-api: base URL, linked sender number, recipients. */
  signalApiUrl?: string;
  signalNumber?: string;
  signalRecipients: string[];
  /** Two-way Signal: when on, the agent polls the bridge for inbound messages
   * and answers diagnosis questions / approval commands. Off by default. */
  signalInbound: boolean;
  alertRules: AlertRule[];
  worker: RoleSelection;
  supervisor: RoleSelection;
  limits: OperationalLimits;
}

/** Parse the `alertRules` JSON blob out of the assistant-config data map. */
export function parseAlertRulesFromConfig(data: Record<string, string>): AlertRule[] {
  return parseAlertRules(data["alertRules"]);
}

/** Parse one role's {provider, model, effort} from the config data, with
 *  backward-compat fallbacks: provider→claude, model→the legacy Config model. */
export function parseRoleSelection(
  data: Record<string, string>,
  role: "worker" | "supervisor",
  fallbackModel: string,
): RoleSelection {
  const rawProvider = (data[`${role}Provider`] ?? "").trim();
  const provider = PROVIDERS.has(rawProvider as ProviderId) ? (rawProvider as ProviderId) : "claude";
  const rawModel = (data[`${role}Model`] ?? "").trim();
  const model = rawModel || fallbackModel;
  const rawEffort = (data[`${role}Effort`] ?? "").trim();
  return { provider, model, effort: rawEffort || undefined };
}

/** Parse one numeric limit, falling back to the Config value on absence/junk. */
function numKey(data: Record<string, string>, key: string, fallback: number): number {
  const raw = (data[key] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse the operational limits, each falling back to the deploy-time Config value.
 *  NOTE (Plan 1): rc.limits is parsed here, but the poll loop still reads the static
 *  Config values. Wiring rc.limits into tick()/main() + the circuit breaker is deferred
 *  to Plan 2 (control plane), alongside the /api/assistant `setLimits` action and the UI
 *  that lets users change them. Until something writes these ConfigMap keys, rc.limits
 *  equals the Config defaults, so consuming it now would be a behavioral no-op. */
export function parseLimits(data: Record<string, string>, cfg: Config): OperationalLimits {
  const rawNs = (data["namespaces"] ?? "").trim();
  const namespaces = rawNs
    ? rawNs.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    : cfg.namespaces;
  return {
    pollIntervalMs: numKey(data, "pollIntervalMs", cfg.pollIntervalMs),
    maxPerResourcePerHour: numKey(data, "maxPerResourcePerHour", cfg.maxPerResourcePerHour),
    maxPerNight: numKey(data, "maxPerNight", cfg.maxPerNight),
    maxAttemptsPerIncident: numKey(data, "maxAttemptsPerIncident", cfg.maxAttemptsPerIncident),
    confirmPolls: numKey(data, "confirmPolls", cfg.confirmPolls),
    namespaces,
  };
}

/** Parse "HH:MM-HH:MM" into minutes-of-day. Null on malformed input. */
export function parseWindow(raw: string): TimeWindow | null {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const sh = Number(m[1]), sm = Number(m[2]), eh = Number(m[3]), em = Number(m[4]);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
}

/** Is minute-of-day `now` inside the window? Handles overnight wraparound. */
export function inWindow(now: number, w: TimeWindow): boolean {
  if (w.startMin <= w.endMin) return now >= w.startMin && now < w.endMin;
  return now >= w.startMin || now < w.endMin; // wraps midnight
}

/** Whether a remediation may auto-execute now, given the autonomy mode. */
export function decideAutonomy(
  mode: AutonomyMode,
  window: TimeWindow | undefined,
  nowMinOfDay: number,
): "auto" | "queue" {
  if (mode === "advisory") return "queue";
  if (mode === "window") return window && inWindow(nowMinOfDay, window) ? "auto" : "queue";
  return "auto";
}

function disabledDefaults(cfg: Config): RuntimeConfig {
  return {
    enabled: false, mode: "auto", silenced: new Set(), window: undefined,
    signalRecipients: [], signalInbound: false, alertRules: [],
    worker: parseRoleSelection({}, "worker", cfg.workerModel),
    supervisor: parseRoleSelection({}, "supervisor", cfg.supervisorModel),
    limits: parseLimits({}, cfg),
  };
}

/** Read the live control surface. Fail-closed (disabled) if the ConfigMap is
 * missing/unreadable — same as the kill-switch default. */
export async function readRuntimeConfig(cfg: Config): Promise<RuntimeConfig> {
  const res = await kubectl(["get", "configmap", cfg.configConfigMap, "-n", cfg.stateNamespace, "-o", "json"]);
  if (res.code !== 0) return disabledDefaults(cfg);
  let data: Record<string, string> = {};
  try {
    data = (JSON.parse(res.stdout) as { data?: Record<string, string> }).data ?? {};
  } catch {
    return disabledDefaults(cfg);
  }
  const mode = (data.mode as AutonomyMode) || "auto";
  const silenced = new Set(
    (data.silenced ?? "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const signalRecipients = (data.signalRecipients ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    enabled: data.enabled !== "false",
    mode: mode === "advisory" || mode === "window" ? mode : "auto",
    window: data.window ? parseWindow(data.window) ?? undefined : undefined,
    silenced,
    webhookUrl: data.webhookUrl && data.webhookUrl.trim() ? data.webhookUrl.trim() : undefined,
    signalApiUrl: data.signalApiUrl && data.signalApiUrl.trim() ? data.signalApiUrl.trim() : undefined,
    signalNumber: data.signalNumber && data.signalNumber.trim() ? data.signalNumber.trim() : undefined,
    signalRecipients,
    signalInbound: data.signalInbound === "true",
    alertRules: parseAlertRulesFromConfig(data),
    worker: parseRoleSelection(data, "worker", cfg.workerModel),
    supervisor: parseRoleSelection(data, "supervisor", cfg.supervisorModel),
    limits: parseLimits(data, cfg),
  };
}
