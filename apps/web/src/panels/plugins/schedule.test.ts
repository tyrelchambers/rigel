import { describe, it, expect } from "vitest";
import { intervalToCron, cronToInterval, clampInterval, humanEvery, SCHEDULE_PRESETS } from "./schedule";

describe("intervalToCron", () => {
  it("maps each unit to the right cron", () => {
    expect(intervalToCron(30, "minutes")).toBe("*/30 * * * *");
    expect(intervalToCron(6, "hours")).toBe("0 */6 * * *");
    expect(intervalToCron(2, "days")).toBe("0 0 */2 * *");
  });
  it("clamps to the unit's valid range and floors to >= 1", () => {
    expect(intervalToCron(90, "minutes")).toBe("*/59 * * * *");
    expect(intervalToCron(40, "hours")).toBe("0 */23 * * *");
    expect(intervalToCron(0, "minutes")).toBe("*/1 * * * *");
    expect(intervalToCron(-5, "days")).toBe("0 0 */1 * *");
  });
});

describe("cronToInterval", () => {
  it("round-trips the crons intervalToCron produces", () => {
    expect(cronToInterval("*/30 * * * *")).toEqual({ amount: 30, unit: "minutes" });
    expect(cronToInterval("0 */6 * * *")).toEqual({ amount: 6, unit: "hours" });
    expect(cronToInterval("0 0 */2 * *")).toEqual({ amount: 2, unit: "days" });
  });
  it("falls back to a sane default for anything it can't parse", () => {
    expect(cronToInterval("0 3 * * 1")).toEqual({ amount: 30, unit: "minutes" });
    expect(cronToInterval("nonsense")).toEqual({ amount: 30, unit: "minutes" });
  });
});

describe("clampInterval", () => {
  it("keeps values within [1, unit max]", () => {
    expect(clampInterval(70, "minutes")).toBe(59);
    expect(clampInterval(0, "hours")).toBe(1);
    expect(clampInterval(5, "days")).toBe(5);
  });
});

describe("humanEvery", () => {
  it("pluralizes the unit except when the amount is 1", () => {
    expect(humanEvery(30, "minutes")).toBe("every 30 minutes");
    expect(humanEvery(1, "hours")).toBe("every 1 hour");
    expect(humanEvery(2, "days")).toBe("every 2 days");
    expect(humanEvery(1, "minutes")).toBe("every 1 minute");
  });
});

describe("SCHEDULE_PRESETS", () => {
  it("are the design's six presets, each a cron intervalToCron round-trips", () => {
    expect(SCHEDULE_PRESETS.map((p) => p.label)).toEqual(["5m", "15m", "30m", "1h", "6h", "12h"]);
    for (const p of SCHEDULE_PRESETS) {
      const { amount, unit } = cronToInterval(p.cron);
      expect(intervalToCron(amount, unit)).toBe(p.cron);
    }
  });
});
