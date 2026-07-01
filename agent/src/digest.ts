// agent/src/digest.ts
// Scheduled cluster digests — schedule evaluation, window assembly, the
// deterministic body, an optional AI headline, and the send. Owned by the agent
// (the only component with the rolling state, the LLM path, and the channels).
import type { DigestSubscription } from "@rigel/k8s/src/digest.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import { parseHHMM } from "./runtimeConfig.js";
import type { AssistantState, IncidentRecord, PullRequestRecord } from "./state.js";

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

/** The zone's UTC offset (ms) at a given absolute instant. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  // 24:00 → 0 normalization that some engines emit for midnight
  const hour = p.hour === 24 ? 0 : p.hour!;
  const asUTC = Date.UTC(p.year!, p.month! - 1, p.day!, hour, p.minute!, p.second!);
  return asUTC - utcMs;
}

/** The absolute instant of a local wall-clock time in `tz` (DST-aware; two-pass). */
function zonedWallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(tz, naive);
  const guess = naive - off1;
  const off2 = tzOffsetMs(tz, guess);
  return naive - off2;
}

/** The local Y/M/D + weekday for an instant, in `tz`. */
function localParts(tz: string, utcMs: number): { y: number; mo: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), weekday: WD[p.weekday!]! };
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

/** The always-sent deterministic body. Plain text suitable for a phone. */
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
    if (pullRequests.length > 0) {
      lines.push(`${pluralize(pullRequests.length, "fix PR")} opened.`);
    }
    lines.push("");
    for (const i of incidents.slice(0, 10)) {
      const tail = i.disposition === "resolved" ? "resolved" : i.disposition;
      lines.push(`• ${i.location} — ${i.reason} (${tail})`);
    }
    for (const p of pullRequests.slice(0, 10)) {
      lines.push(`• PR: ${p.app} — ${p.title}${p.prUrl ? ` (${p.prUrl})` : ""}`);
    }
  }
  lines.push("");
  lines.push(`Now: ${health.totalPods} pods, ${health.totalDeployments} deployments, ` +
    `${pluralize(health.currentIncidents, "active issue")}` +
    (queueCount > 0 ? `, ${pluralize(queueCount, "item")} awaiting approval.` : "."));
  return lines.join("\n");
}

// ---- Task 10: AI headline + composeDigestMessage ----
import { runModel } from "./runModel.js";

const DIGEST_SYSTEM_PROMPT = `You are Rigel's cluster assistant writing the one-line opening of a scheduled digest an operator reads on their phone in the morning.

You are given a structured summary of what happened to their Kubernetes cluster during a time window. Reply with a SINGLE plain-text sentence (no markdown, no greeting, under ~140 characters) that captures the headline: was it a quiet night, were there issues, did anything still need them. Do not restate every detail — the structured body follows your sentence. If nothing happened, say so plainly.`;

function renderDigestPrompt(data: DigestData): string {
  return [
    `Cluster digest data (JSON):`,
    JSON.stringify({
      window_hours: Math.round((data.windowEndMs - data.windowStartMs) / 3_600_000),
      incidents: data.incidents.map((i) => ({ location: i.location, reason: i.reason, disposition: i.disposition })),
      fix_prs: data.pullRequests.map((p) => ({ app: p.app, title: p.title, status: p.status })),
      awaiting_approval: data.queueCount,
      now: data.health,
    }),
    ``,
    `Write the one-line headline.`,
  ].join("\n");
}

/** The AI headline, or null on any model error (caller sends the body alone). */
export async function generateDigestHeadline(rc: RuntimeConfig, data: DigestData): Promise<string | null> {
  try {
    const result = await runModel({
      role: "worker", config: rc, prompt: renderDigestPrompt(data),
      systemPrompt: DIGEST_SYSTEM_PROMPT, timeoutMs: 60_000,
    });
    if (result.isError) return null;
    const line = result.text.trim().split("\n")[0]?.trim();
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** The full message: deterministic body, with an AI headline prepended when available. */
export async function composeDigestMessage(rc: RuntimeConfig, data: DigestData): Promise<string> {
  const body = renderDigestText(data);
  const headline = await generateDigestHeadline(rc, data);
  return headline ? `${headline}\n\n${body}` : body;
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
