export type IntervalUnit = "minutes" | "hours" | "days";

/** Largest valid amount per unit so the generated cron field stays legal. */
export const INTERVAL_MAX: Record<IntervalUnit, number> = { minutes: 59, hours: 23, days: 31 };

/** Clamp an amount to [1, unit max], flooring and defaulting a blank/NaN to 1. */
export function clampInterval(amount: number, unit: IntervalUnit): number {
  return Math.min(Math.max(1, Math.floor(amount || 1)), INTERVAL_MAX[unit]);
}

/** Turn a friendly "every N <unit>" into a cron expression. */
export function intervalToCron(amount: number, unit: IntervalUnit): string {
  const n = clampInterval(amount, unit);
  if (unit === "minutes") return `*/${n} * * * *`;
  if (unit === "hours") return `0 */${n} * * *`;
  return `0 0 */${n} * *`;
}

/** Parse a cron expression back into "every N <unit>"; sane default if unrecognized. */
export function cronToInterval(cron: string): { amount: number; unit: IntervalUnit } {
  let m: RegExpExecArray | null;
  if ((m = /^\*\/(\d+) \* \* \* \*$/.exec(cron))) return { amount: Number(m[1]), unit: "minutes" };
  if ((m = /^0 \*\/(\d+) \* \* \*$/.exec(cron))) return { amount: Number(m[1]), unit: "hours" };
  if ((m = /^0 0 \*\/(\d+) \* \*$/.exec(cron))) return { amount: Number(m[1]), unit: "days" };
  return { amount: 30, unit: "minutes" };
}

/** Human summary of an interval, e.g. "every 30 minutes" / "every 1 hour". */
export function humanEvery(amount: number, unit: IntervalUnit): string {
  const n = clampInterval(amount, unit);
  const word = n === 1 ? unit.slice(0, -1) : unit;
  return `every ${n} ${word}`;
}

/** Quick-pick cadences shown as pills above the interval control. */
export const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: "5m", cron: intervalToCron(5, "minutes") },
  { label: "15m", cron: intervalToCron(15, "minutes") },
  { label: "30m", cron: intervalToCron(30, "minutes") },
  { label: "1h", cron: intervalToCron(1, "hours") },
  { label: "6h", cron: intervalToCron(6, "hours") },
  { label: "12h", cron: intervalToCron(12, "hours") },
];
