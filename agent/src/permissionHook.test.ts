import { describe, test, expect } from "vitest";
import { decide } from "./permissionHook.js";

describe("agent permission hook decide()", () => {
  test("read → allow", () => {
    expect(decide("kubectl get pods").permissionDecision).toBe("allow");
  });
  test("reversible → allow", () => {
    expect(decide("kubectl rollout restart deployment/api").permissionDecision).toBe("allow");
  });
  test("destructive → deny with confirm hint", () => {
    const d = decide("kubectl delete pod foo");
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/DESTRUCTIVE/i);
  });
  test("blocked → deny", () => {
    expect(decide("kubectl port-forward svc/a 80:80").permissionDecision).toBe("deny");
  });
});

describe("secret values never reach the ledger", () => {
  test("a read that would print them is denied and names describe", () => {
    const d = decide("kubectl get secret db -n default -o yaml");
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toContain("describe secret");
  });

  test("the shape is still readable", () => {
    expect(decide("kubectl describe secret db -n default").permissionDecision).toBe("allow");
  });
});
