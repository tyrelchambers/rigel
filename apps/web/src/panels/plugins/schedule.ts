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
