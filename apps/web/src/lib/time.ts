// Shared relative-age formatters. One option-driven compact formatter plus a
// spelled long-form wrapper, consolidating the ~7 hand-rolled copies that used
// to live in the individual panel `*Display.ts` files. date-fns supplies the
// arithmetic (`differenceInSeconds`); the compact output ("5s" / "3m" / "2h" /
// "1d") is produced here because date-fns' own `formatDistanceToNowStrict`
// spells the units out ("5 seconds"), which would change user-visible strings.

import { differenceInSeconds } from "date-fns";

const SEC_PER_MINUTE = 60;
const SEC_PER_HOUR = 3600;
const SEC_PER_DAY = 86400;

/** Parse an ISO string or epoch-ms number to epoch ms, or null when unusable. */
function parseInstant(input: string | number | undefined | null): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isNaN(input) ? null : input;
  const t = Date.parse(input);
  return Number.isNaN(t) ? null : t;
}

export interface CompactAgeOpts {
  /** Reference "now" instant (epoch ms). Defaults to `Date.now()`. */
  now?: number;
  /** Returned for missing/unparseable input. Defaults to "—". */
  invalid?: string | null;
  /** Append " ago" to the rendered value. Defaults to false. */
  suffix?: boolean;
  /** Render a negative (future) delta as "0s". Defaults to false. */
  clampFuture?: boolean;
  /** Cap the largest unit: "h" never rolls up to days. Defaults to "d". */
  maxUnit?: "h" | "d";
  /** Sub-60s rendering: compact seconds, or the phrase "just now". Defaults to "seconds". */
  belowMinute?: "seconds" | "just now";
}

/**
 * Compact relative age ("5s" / "3m" / "2h" / "1d") of an ISO string or epoch-ms
 * instant relative to `now`, picking the largest unit. Returns `invalid` for
 * missing/unparseable input. Measures `differenceInSeconds(now, then)`, so
 * passing `now = <end>` and `input = <start>` yields a positive duration.
 */
export function compactAge(
  input: string | number | undefined | null,
  opts?: CompactAgeOpts & { invalid?: string },
): string;
export function compactAge(
  input: string | number | undefined | null,
  opts: CompactAgeOpts & { invalid: null },
): string | null;
export function compactAge(
  input: string | number | undefined | null,
  opts: CompactAgeOpts = {},
): string | null {
  const {
    now = Date.now(),
    invalid = "—",
    suffix = false,
    clampFuture = false,
    maxUnit = "d",
    belowMinute = "seconds",
  } = opts;

  const then = parseInstant(input);
  if (then === null) return invalid;

  const sec = differenceInSeconds(now, then);
  const withSuffix = (s: string) => (suffix ? `${s} ago` : s);

  // clampFuture takes precedence over belowMinute: a future instant renders
  // "0s", never "just now" (no caller combines the two today).
  if (clampFuture && sec < 0) return withSuffix("0s");
  if (sec < SEC_PER_MINUTE) {
    if (belowMinute === "just now") return "just now";
    return withSuffix(`${sec}s`);
  }
  if (sec < SEC_PER_HOUR) return withSuffix(`${Math.floor(sec / SEC_PER_MINUTE)}m`);
  if (maxUnit === "h" || sec < SEC_PER_DAY) return withSuffix(`${Math.floor(sec / SEC_PER_HOUR)}h`);
  return withSuffix(`${Math.floor(sec / SEC_PER_DAY)}d`);
}

/**
 * Long, spelled-out age ("just now" / "1 minute" / "3 minutes" / "1 hour" /
 * "165 days") of an ISO string or epoch-ms instant relative to `now`. Largest
 * unit only, pluralized. Future instants clamp to "just now". Returns "" for
 * missing/unparseable input (callers that need a placeholder guard first).
 */
export function spelledAge(
  input: string | number | undefined | null,
  now: number = Date.now(),
): string {
  const then = parseInstant(input);
  if (then === null) return "";

  const s = Math.max(0, differenceInSeconds(now, then));
  const units: [number, string][] = [
    [SEC_PER_DAY, "day"],
    [SEC_PER_HOUR, "hour"],
    [SEC_PER_MINUTE, "minute"],
  ];
  for (const [secs, label] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${label}${n === 1 ? "" : "s"}`;
    }
  }
  return "just now";
}
