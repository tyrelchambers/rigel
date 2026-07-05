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
