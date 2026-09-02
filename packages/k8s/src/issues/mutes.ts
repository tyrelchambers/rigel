import { addHours } from "date-fns";

export interface IssueMute {
  until: string | null;
}

export type IssueMutes = Record<string, IssueMute>;

/** Whether this fingerprint is currently silenced: indefinitely, or by a snooze
 *  whose instant has not passed. */
export function isMuted(mutes: IssueMutes, fingerprint: string, now = new Date()): boolean {
  const m = mutes[fingerprint];
  if (!m) return false;
  if (m.until === null) return true;
  return Date.parse(m.until) > now.getTime();
}

/** A new map with this fingerprint muted. Never mutates the input. */
export function setMute(
  mutes: IssueMutes,
  fingerprint: string,
  snooze: { hours: number } | null,
  now = new Date(),
): IssueMutes {
  const until = snooze ? addHours(now, snooze.hours).toISOString() : null;
  return { ...mutes, [fingerprint]: { until } };
}

/** A new map without this fingerprint. */
export function clearMute(mutes: IssueMutes, fingerprint: string): IssueMutes {
  const { [fingerprint]: _drop, ...rest } = mutes;
  return rest;
}

/** Total: absent, empty, malformed or wrong-shaped JSON all read as no mutes,
 *  and an entry that is not shaped like a mute is dropped rather than kept. */
export function parseIssueMutes(raw: string | undefined): IssueMutes {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: IssueMutes = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const until = (v as { until?: unknown }).until;
    if (until === null || typeof until === "string") out[k] = { until: until ?? null };
  }
  return out;
}

export function serializeIssueMutes(mutes: IssueMutes): string {
  return JSON.stringify(mutes);
}
