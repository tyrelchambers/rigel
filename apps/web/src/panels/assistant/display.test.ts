import { describe, it, expect } from "vitest";
import {
  tokenLabel,
  tokenColorClass,
  outcomeGlyph,
  outcomeColorClass,
  auditCanExpand,
  relativeTime,
  spendLabel,
  auditCount,
} from "./display";

describe("tokenLabel", () => {
  it("shows days left for ok/warning and a re-run hint when expired", () => {
    expect(tokenLabel({ daysRemaining: 200, level: "ok" })).toBe("200d left");
    expect(tokenLabel({ daysRemaining: 12, level: "warning" })).toBe("12d left");
    expect(tokenLabel({ daysRemaining: -3, level: "expired" })).toBe("expired — re-run setup-token");
  });
});

describe("tokenColorClass", () => {
  it("maps levels to colors (green/amber/red)", () => {
    expect(tokenColorClass("ok")).toContain("muted-foreground");
    expect(tokenColorClass("warning")).toContain("amber");
    expect(tokenColorClass("expired")).toContain("red");
  });
});

describe("audit outcome glyphs + colors", () => {
  it("maps outcomes to ✓/✗/▸/•", () => {
    expect(outcomeGlyph("success")).toBe("✓");
    expect(outcomeGlyph("failure")).toBe("✗");
    expect(outcomeGlyph("queued")).toBe("▸");
    expect(outcomeGlyph("skipped")).toBe("•");
  });
  it("maps outcomes to colors", () => {
    expect(outcomeColorClass("success")).toContain("green");
    expect(outcomeColorClass("failure")).toContain("red");
    expect(outcomeColorClass("queued")).toContain("amber");
    expect(outcomeColorClass("other")).toContain("muted-foreground");
  });
});

describe("auditCanExpand", () => {
  it("expands when there is an analysis or a long detail", () => {
    expect(auditCanExpand("short", undefined)).toBe(false);
    expect(auditCanExpand("short", "some analysis")).toBe(true);
    expect(auditCanExpand("x".repeat(161), undefined)).toBe(true);
    expect(auditCanExpand("x".repeat(160), undefined)).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  it("renders compact s/m/h/d, tolerating fractional seconds", () => {
    expect(relativeTime("2026-06-09T11:59:30Z", now)).toBe("30s");
    // Fractional seconds are tolerated (Date.parse handles the .500); 30m exactly.
    expect(relativeTime("2026-06-09T11:30:00.000Z", now)).toBe("30m");
    expect(relativeTime("2026-06-09T11:29:59.500Z", now)).toBe("30m");
    expect(relativeTime("2026-06-09T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-06-07T12:00:00Z", now)).toBe("2d");
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

describe("spendLabel", () => {
  it('formats "$X.XX/$Y"', () => {
    expect(spendLabel(1.5, 50)).toBe("$1.50/$50");
    expect(spendLabel(0, 50)).toBe("$0.00/$50");
  });
});

describe("auditCount", () => {
  it("counts entries by outcome", () => {
    const audit = [{ outcome: "success" }, { outcome: "failure" }, { outcome: "success" }];
    expect(auditCount(audit, "success")).toBe(2);
    expect(auditCount(audit, "failure")).toBe(1);
    expect(auditCount(audit, "queued")).toBe(0);
  });
});
