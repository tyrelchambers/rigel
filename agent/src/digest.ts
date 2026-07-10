// agent/src/digest.ts
// Scheduled cluster digests — schedule evaluation, window assembly, the
// deterministic body, an optional AI headline, and the send. Owned by the agent
// (the only component with the rolling state, the LLM path, and the channels).
import type { DigestSubscription } from "@rigel/k8s/src/digest.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import { parseHHMM } from "./runtimeConfig.js";
import type { AssistantState, IncidentRecord, PullRequestRecord } from "./state.js";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

/** The data a single digest summarizes — assembled purely from already-fetched
 * tick state, no new cluster reads. */
export interface DigestData {
  sub: DigestSubscription;
  windowStartMs: number;
  windowEndMs: number;
  incidents: IncidentRecord[];
  pullRequests: PullRequestRecord[];
  queueCount: number;
  health: { totalPods: number; totalDeployments: number; currentIncidents: number };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The absolute instant of a local wall-clock time in `tz` (DST-aware). The
 * timezone-neutral date-string form lets `fromZonedTime` resolve the wall-clock
 * fields in `tz` (and disambiguate DST transitions) without the runner's local
 * offset leaking in.
 *
 * For the ambiguous fall-back hour, date-fns-tz picks one offset
 * deterministically. This can differ from the old two-pass result in
 * positive-offset zones (e.g. Europe/London), but each slot still resolves to
 * exactly one instant, so a digest fires once/day (never double-fires).
 * America/Toronto (and other negative-offset zones) match the old behavior
 * byte-for-byte. */
function zonedWallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  return fromZonedTime(`${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:00`, tz).getTime();
}

/** The local Y/M/D + weekday for an instant, in `tz` (weekday 0=Sun..6=Sat). */
function localParts(tz: string, utcMs: number): { y: number; mo: number; d: number; weekday: number } {
  const z = toZonedTime(utcMs, tz);
  return { y: z.getFullYear(), mo: z.getMonth() + 1, d: z.getDate(), weekday: z.getDay() };
}

/** The most recent scheduled slot instant that is ≤ now, or null when none in the
 * last 8 days (e.g. an empty `days`). */
export function mostRecentSlot(sub: DigestSubscription, now: number): number | null {
  const slot = parseHHMM(sub.time);
  if (slot === null || sub.days.length === 0) return null;
  for (let back = 0; back < 8; back++) {
    const probe = now - back * 86_400_000;
    const { y, mo, d, weekday } = localParts(sub.timezone, probe);
    if (!sub.days.includes(weekday)) continue;
    const inst = zonedWallToUtc(sub.timezone, y, mo, d, Math.floor(slot / 60), slot % 60);
    if (inst <= now) return inst;
  }
  return null;
}

/** Whether an armed subscription is due: its most-recent slot is later than its
 * last send. Callers arm a brand-new subscription before asking (Task 11). */
export function isDigestDue(sub: DigestSubscription, lastSentAtISO: string | undefined, now: number): boolean {
  if (!sub.enabled) return false;
  const slotInst = mostRecentSlot(sub, now);
  if (slotInst === null) return false;
  const last = lastSentAtISO ? Date.parse(lastSentAtISO) : NaN;
  if (!Number.isFinite(last)) return true; // unarmed → treat as due (orchestrator arms first)
  return last < slotInst;
}

// ---- Task 9: assembleDigestData + renderDigestText ----

/** A minimal view of the tick's detection — only what the health snapshot needs. */
export interface DigestDetectionView {
  pods: unknown[];
  deps: unknown[];
  incidents: unknown[];
}

const DEFAULT_FIRST_RUN_MS = 24 * 3_600_000;

/** Compute the window + filter state to it. Pure; no cluster reads. */
export function assembleDigestData(
  state: AssistantState,
  detection: DigestDetectionView,
  sub: DigestSubscription,
  now: number,
  lastSentAtISO: string | undefined,
): DigestData {
  let windowStartMs: number;
  if (sub.lookback.mode === "fixed") {
    windowStartMs = now - sub.lookback.hours * 3_600_000;
  } else {
    const last = lastSentAtISO ? Date.parse(lastSentAtISO) : NaN;
    windowStartMs = Number.isFinite(last) ? last : now - DEFAULT_FIRST_RUN_MS;
  }
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= windowStartMs && t <= now;
  };
  const incidents = (state.incidents ?? []).filter((r) => inWindow(r.lastSeenAt) || inWindow(r.at));
  const pullRequests = (state.pullRequests ?? []).filter((p) => inWindow(p.at));
  return {
    sub, windowStartMs, windowEndMs: now,
    incidents, pullRequests,
    queueCount: state.queue.length,
    health: {
      totalPods: detection.pods.length,
      totalDeployments: detection.deps.length,
      currentIncidents: detection.incidents.length,
    },
  };
}

function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Fallback body, sent ONLY when the model is unavailable (see composeDigestMessage).
 *  Deliberately dumb: raw counts and a pointer to Rigel, no per-incident list — the
 *  AI owns presentation, so this just guarantees the scheduled digest still lands. */
export function renderDigestText(data: DigestData): string {
  const { sub, incidents, pullRequests, queueCount, health } = data;
  const byDisp = (d: IncidentRecord["disposition"]) => incidents.filter((i) => i.disposition === d).length;
  const lines: string[] = [];
  lines.push(`${sub.label}`);
  const hours = Math.max(1, Math.round((data.windowEndMs - data.windowStartMs) / 3_600_000));
  lines.push(`Window: last ${pluralize(hours, "hour")}.`);
  lines.push("");
  if (incidents.length === 0 && pullRequests.length === 0) {
    lines.push("No incidents. Cluster stayed healthy.");
  } else {
    lines.push(`${pluralize(incidents.length, "incident")}: ` +
      `${byDisp("autoFixed")} auto-fixed, ${byDisp("queued")} awaiting you, ` +
      `${byDisp("resolved")} resolved, ${byDisp("flagged")} flagged.`);
    if (pullRequests.length > 0) lines.push(`${pluralize(pullRequests.length, "fix PR")} opened.`);
    lines.push("Open Rigel for the full breakdown.");
  }
  lines.push("");
  lines.push(`Now: ${health.totalPods} pods, ${health.totalDeployments} deployments, ` +
    `${pluralize(health.currentIncidents, "active issue")}` +
    (queueCount > 0 ? `, ${pluralize(queueCount, "item")} awaiting approval.` : "."));
  return lines.join("\n");
}

// ---- Task 10: AI headline + composeDigestMessage ----
import { runModel } from "./runModel.js";

const DIGEST_SYSTEM_PROMPT = `You are Rigel's cluster assistant writing a scheduled digest an operator reads on their phone. You are given a structured JSON summary of what happened to their Kubernetes cluster during a time window.

Write the whole digest as plain text (no markdown tables or headers), tuned for a small screen:
- Open with ONE honest headline sentence: was it a quiet night, or does something still need them.
- Then summarize what happened. GROUP repetitive or ephemeral items — many pods of the same Job/CronJob/Deployment, or the same error across replicas — into a SINGLE line with a count (e.g. "descheduler-nodejoin: 38 failed job pods, 7 still flagged"). NEVER list ephemeral pods one by one; that is the whole point.
- Lead with anything still needing them (flagged, or awaiting their approval); de-emphasize what already resolved itself.
- Mention opened fix PRs and current health briefly if relevant.
- Use the counts you are given; do not recount or invent numbers. Keep it short — a handful of lines, well under a screen. If nothing happened, say so in one line.`;

function dispositionTotals(incidents: IncidentRecord[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const i of incidents) t[i.disposition] = (t[i.disposition] ?? 0) + 1;
  return t;
}

const MAX_PROMPT_INCIDENTS = 200;

function renderDigestPrompt(data: DigestData): string {
  const shown = data.incidents.slice(0, MAX_PROMPT_INCIDENTS);
  return [
    `Cluster digest data (JSON):`,
    JSON.stringify({
      title: data.sub.label,
      window_hours: Math.round((data.windowEndMs - data.windowStartMs) / 3_600_000),
      totals: { incidents: data.incidents.length, ...dispositionTotals(data.incidents) },
      incidents: shown.map((i) => ({ location: i.location, reason: i.reason, disposition: i.disposition })),
      incidents_omitted: data.incidents.length - shown.length,
      fix_prs: data.pullRequests.map((p) => ({ app: p.app, title: p.title, status: p.status })),
      awaiting_approval: data.queueCount,
      now: data.health,
    }),
    ``,
    `Write the digest.`,
  ].join("\n");
}

/** Let the model write and lay out the whole digest from the structured data —
 *  it decides how to group and prioritize. Null on any model error, so the caller
 *  falls back to the deterministic body (so a scheduled digest never silently
 *  fails to send when the model/credential is down). */
export async function generateDigestBody(rc: RuntimeConfig, data: DigestData): Promise<string | null> {
  try {
    const result = await runModel({
      role: "worker", config: rc, prompt: renderDigestPrompt(data),
      systemPrompt: DIGEST_SYSTEM_PROMPT, timeoutMs: 90_000,
    });
    if (result.isError) return null;
    const text = result.text.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** The digest to send: the AI-composed body, or the deterministic grouped body
 *  when the model is unavailable. */
export async function composeDigestMessage(rc: RuntimeConfig, data: DigestData): Promise<string> {
  return (await generateDigestBody(rc, data)) ?? renderDigestText(data);
}

// ---- Task 11: evaluateDigests orchestrator + sendToChannel ----
import { notifyWebhook, notifySignal, notifyMatrix } from "./notify.js";
import type { DigestState } from "./state.js";

/** Dispatch a rendered digest to the subscription's channel (best-effort). */
async function sendToChannel(rc: RuntimeConfig, channel: DigestSubscription["channel"], text: string): Promise<void> {
  if (channel === "webhook" && rc.webhookUrl) {
    await notifyWebhook(rc.webhookUrl, text);
  } else if (channel === "signal" && rc.signalApiUrl && rc.signalNumber) {
    await notifySignal(rc.signalApiUrl, rc.signalNumber, rc.signalRecipients, text);
  } else if (channel === "matrix" && rc.matrix.homeserverUrl && rc.matrix.accessToken && rc.matrix.roomId) {
    await notifyMatrix(rc.matrix.homeserverUrl, rc.matrix.accessToken, rc.matrix.roomId, text);
  }
  // channel not configured → silently skip (best-effort, like flushNotifications)
}

/**
 * Evaluate every digest subscription this tick: handle a run-now trigger, arm new
 * subscriptions, and send any that are due. Returns the new state (caller persists
 * it in the same writeState). Pure w.r.t. cluster reads — only sends notifications.
 */
export async function evaluateDigests(
  rc: RuntimeConfig,
  state: AssistantState,
  detection: DigestDetectionView,
  now: number,
): Promise<AssistantState> {
  const nowISO = new Date(now).toISOString();
  let ds: DigestState = state.digestState ?? { lastSentAt: {} };
  let next = state;
  const byId = new Map(rc.digests.map((s) => [s.id, s]));

  // 1) Run-now / preview trigger (idempotent by token).
  const trigger = rc.digestRunNow;
  if (trigger && trigger.token !== ds.lastRunNowToken) {
    const sub = byId.get(trigger.id);
    if (sub) {
      const data = assembleDigestData(next, detection, sub, now, ds.lastSentAt[sub.id]);
      const text = await composeDigestMessage(rc, data);
      if (trigger.mode === "send") {
        await sendToChannel(rc, sub.channel, text);
      } else {
        ds = { ...ds, lastPreview: { id: sub.id, at: nowISO, text } };
      }
    }
    ds = { ...ds, lastRunNowToken: trigger.token };
  }

  // 2) Arm new subscriptions (no retroactive same-day fire), then 3) send due ones.
  for (const sub of rc.digests) {
    const last = ds.lastSentAt[sub.id];
    if (last === undefined) {
      ds = { ...ds, lastSentAt: { ...ds.lastSentAt, [sub.id]: nowISO } };
      continue;
    }
    if (isDigestDue(sub, last, now)) {
      const data = assembleDigestData(next, detection, sub, now, last);
      const text = await composeDigestMessage(rc, data);
      await sendToChannel(rc, sub.channel, text);
      ds = { ...ds, lastSentAt: { ...ds.lastSentAt, [sub.id]: nowISO } };
    }
  }

  // Drop lastSentAt entries for deleted subscriptions (housekeeping).
  const liveIds = new Set(rc.digests.map((s) => s.id));
  const prunedLast: Record<string, string> = {};
  for (const [id, t] of Object.entries(ds.lastSentAt)) if (liveIds.has(id)) prunedLast[id] = t;
  ds = { ...ds, lastSentAt: prunedLast };

  next = { ...next, digestState: ds };
  return next;
}
