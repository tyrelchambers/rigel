import { kubectl } from "./kubectl.js";
import type { Config } from "./config.js";
import { parseAlertRules, type AlertRule } from "./alerts.js";

/**
 * Live, human/Helmsman-editable control surface, read from the `assistant-config`
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
}

/** Parse the `alertRules` JSON blob out of the assistant-config data map. */
export function parseAlertRulesFromConfig(data: Record<string, string>): AlertRule[] {
  return parseAlertRules(data["alertRules"]);
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

/** Read the live control surface. Fail-closed (disabled) if the ConfigMap is
 * missing/unreadable — same as the kill-switch default. */
export async function readRuntimeConfig(cfg: Config): Promise<RuntimeConfig> {
  const res = await kubectl(["get", "configmap", cfg.configConfigMap, "-n", cfg.stateNamespace, "-o", "json"]);
  if (res.code !== 0) return { enabled: false, mode: "auto", silenced: new Set(), window: undefined, signalRecipients: [], signalInbound: false, alertRules: [] };
  let data: Record<string, string> = {};
  try {
    data = (JSON.parse(res.stdout) as { data?: Record<string, string> }).data ?? {};
  } catch {
    return { enabled: false, mode: "auto", silenced: new Set(), window: undefined, signalRecipients: [], signalInbound: false, alertRules: [] };
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
  };
}
