// packages/k8s/src/digest.ts
// Scheduled cluster digests — the domain type + pure helpers shared by the server
// (which stores subscriptions in assistant-config) and the web panel (which lists
// them). The agent owns a mirror of these shapes in agent/src/digest.ts (wire
// contract), exactly as agent/src/alerts.ts mirrors packages/k8s/src/alerts.ts.

export type DigestChannel = "webhook" | "signal" | "matrix";

export type DigestLookback =
  | { mode: "sinceLast" }
  | { mode: "fixed"; hours: number };

export interface DigestSubscription {
  id: string;
  enabled: boolean;
  label: string;
  channel: DigestChannel;
  /** Days of the week this fires, 0=Sun..6=Sat. daily = [0..6]. */
  days: number[];
  /** "HH:MM" send time, interpreted in `timezone`. */
  time: string;
  /** IANA timezone, e.g. "America/Toronto". */
  timezone: string;
  lookback: DigestLookback;
  createdAt: string;
}

const CHANNELS = new Set<DigestChannel>(["webhook", "signal", "matrix"]);

/** "HH:MM" 24h, both fields in range. */
function isValidTime(t: unknown): t is string {
  if (typeof t !== "string") return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/** Non-empty subset of 0..6, deduped + sorted. Returns null when invalid. */
function cleanDays(d: unknown): number[] | null {
  if (!Array.isArray(d)) return null;
  const set = new Set<number>();
  for (const x of d) {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 6) return null;
    set.add(x);
  }
  if (set.size === 0) return null;
  return [...set].sort((a, b) => a - b);
}

/** True when the runtime can resolve this IANA zone. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cleanLookback(l: unknown): DigestLookback | null {
  if (!l || typeof l !== "object") return null;
  const o = l as { mode?: unknown; hours?: unknown };
  if (o.mode === "sinceLast") return { mode: "sinceLast" };
  if (o.mode === "fixed" && typeof o.hours === "number" && o.hours > 0 && o.hours <= 168) {
    return { mode: "fixed", hours: Math.floor(o.hours) };
  }
  return null;
}

/** Tolerant parse of the `digests` JSON string. Drops anything malformed. */
export function parseDigests(json: string | undefined | null): DigestSubscription[] {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: DigestSubscription[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<DigestSubscription>;
    const days = cleanDays(r.days);
    const lookback = cleanLookback(r.lookback);
    if (
      typeof r.id !== "string" || typeof r.label !== "string" ||
      !CHANNELS.has(r.channel as DigestChannel) || !isValidTime(r.time) ||
      !isValidTimezone(r.timezone) || !days || !lookback
    ) continue;
    out.push({
      id: r.id,
      enabled: r.enabled !== false,
      label: r.label,
      channel: r.channel as DigestChannel,
      days,
      time: r.time as string,
      timezone: r.timezone as string,
      lookback,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    });
  }
  return out;
}

export function serializeDigests(list: DigestSubscription[]): string {
  return JSON.stringify(list);
}

export interface DigestInput {
  label: string;
  channel: DigestChannel;
  days: number[];
  time: string;
  timezone: string;
  lookback: DigestLookback;
  enabled?: boolean;
}

/** Validate + stamp a user-submitted subscription. Throws on bad shape (server-side). */
export function normalizeDigest(input: DigestInput, id: string, nowMs: number): DigestSubscription {
  if (typeof input?.label !== "string" || input.label.trim() === "") throw new Error("digest needs a label");
  if (!CHANNELS.has(input.channel)) throw new Error(`invalid digest channel: ${String(input.channel)}`);
  if (!isValidTime(input.time)) throw new Error(`invalid digest time: ${String(input.time)}`);
  if (!isValidTimezone(input.timezone)) throw new Error(`invalid digest timezone: ${String(input.timezone)}`);
  const days = cleanDays(input.days);
  if (!days) throw new Error("digest needs at least one weekday (0–6)");
  const lookback = cleanLookback(input.lookback);
  if (!lookback) throw new Error("invalid digest lookback");
  return {
    id, enabled: input.enabled !== false, label: input.label.trim(), channel: input.channel,
    days, time: input.time.trim(), timezone: input.timezone.trim(), lookback,
    createdAt: new Date(nowMs).toISOString(),
  };
}

/** Pure add/delete/toggle of the subscription list. */
export function nextDigests(
  list: DigestSubscription[],
  op:
    | { op: "add"; sub: DigestSubscription }
    | { op: "delete"; id: string }
    | { op: "toggle"; id: string; enabled: boolean },
): DigestSubscription[] {
  if (op.op === "add") return [...list.filter((s) => s.id !== op.sub.id), op.sub];
  if (op.op === "delete") return list.filter((s) => s.id !== op.id);
  return list.map((s) => (s.id === op.id ? { ...s, enabled: op.enabled } : s));
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A human one-liner for the panel, e.g. "Mon, Wed at 06:30 (UTC)". */
export function digestScheduleSummary(sub: DigestSubscription): string {
  const when = sub.days.length === 7 ? "Daily" : sub.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${when} at ${sub.time} (${sub.timezone})`;
}
