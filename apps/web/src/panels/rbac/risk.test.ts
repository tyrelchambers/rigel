import { describe, expect, it } from "vitest";
import { ruleRisk, grantRisk } from "./risk";
import type { PolicyRule } from "./types";

const rule = (r: Partial<PolicyRule>): PolicyRule => ({ ...r });

describe("ruleRisk", () => {
  it("flags escalation verbs as dangerous", () => {
    expect(ruleRisk(rule({ verbs: ["escalate"], resources: ["roles"] }))).toBe("dangerous");
    expect(ruleRisk(rule({ verbs: ["bind"], resources: ["clusterroles"] }))).toBe("dangerous");
    expect(ruleRisk(rule({ verbs: ["impersonate"], resources: ["users"] }))).toBe("dangerous");
  });

  it("flags secret reads as dangerous", () => {
    expect(ruleRisk(rule({ verbs: ["get", "list"], resources: ["secrets"] }))).toBe("dangerous");
    expect(ruleRisk(rule({ verbs: ["create"], resources: ["secrets"] }))).toBeNull(); // create-only secrets is not a read → not dangerous
  });

  it("flags full wildcard (verbs * on resources *) as dangerous", () => {
    expect(ruleRisk(rule({ verbs: ["*"], resources: ["*"] }))).toBe("dangerous");
  });

  it("flags a lone wildcard as wildcard tier", () => {
    expect(ruleRisk(rule({ verbs: ["get", "list"], resources: ["*"] }))).toBe("dangerous"); // wildcard resource + read = secret-reachable → dangerous
    expect(ruleRisk(rule({ verbs: ["*"], resources: ["pods"] }))).toBe("wildcard");
  });

  it("returns null for benign read rules", () => {
    expect(ruleRisk(rule({ verbs: ["get", "list", "watch"], resources: ["pods"] }))).toBeNull();
  });
});

describe("grantRisk", () => {
  it("is dangerous when any rule is dangerous", () => {
    expect(
      grantRisk([
        rule({ verbs: ["get"], resources: ["pods"] }),
        rule({ verbs: ["*"], resources: ["*"] }),
      ]),
    ).toBe("dangerous");
  });
  it("is wildcard when the worst rule is wildcard", () => {
    expect(grantRisk([rule({ verbs: ["*"], resources: ["pods"] })])).toBe("wildcard");
  });
  it("is null for all-benign rules", () => {
    expect(grantRisk([rule({ verbs: ["get"], resources: ["pods"] })])).toBeNull();
  });
});
