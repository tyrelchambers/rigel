import { describe, it, expect } from "vitest";
import {
  canRunAudit,
  parseUnlockedAudits,
  DEFAULT_AUDIT_ENTITLEMENT,
  ALL_AUDIT_KINDS,
} from "./auditEntitlement";

describe("canRunAudit", () => {
  it("allows an unlocked audit", () => {
    expect(canRunAudit("security", { unlocked: ["security"] })).toEqual({ allowed: true });
  });

  it("blocks a locked audit with a reason naming the kind", () => {
    const gate = canRunAudit("performance", { unlocked: ["reliability"] });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("performance");
    expect(gate.reason).toContain("premium");
  });

  it("allows everything under the default entitlement", () => {
    for (const kind of ALL_AUDIT_KINDS) {
      expect(canRunAudit(kind, DEFAULT_AUDIT_ENTITLEMENT).allowed).toBe(true);
    }
  });
});

describe("parseUnlockedAudits", () => {
  it("unlocks all when the value is absent or empty", () => {
    expect(parseUnlockedAudits(undefined).unlocked.sort()).toEqual([...ALL_AUDIT_KINDS].sort());
    expect(parseUnlockedAudits("").unlocked.sort()).toEqual([...ALL_AUDIT_KINDS].sort());
    expect(parseUnlockedAudits("  ").unlocked.sort()).toEqual([...ALL_AUDIT_KINDS].sort());
  });

  it("unlocks only the listed kinds, dropping unknown tokens and whitespace", () => {
    expect(parseUnlockedAudits("reliability, security , bogus").unlocked).toEqual([
      "reliability",
      "security",
    ]);
  });

  it("can lock everything with a comma of unknowns", () => {
    expect(parseUnlockedAudits("nope,nada").unlocked).toEqual([]);
  });
});
