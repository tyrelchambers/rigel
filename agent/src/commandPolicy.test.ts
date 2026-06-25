import { describe, expect, test } from "vitest";
import { classifyCommand } from "./commandPolicy.js";

describe("classifyCommand (agent port)", () => {
  test("plain reads are allowed", () => {
    expect(classifyCommand("kubectl get pods").decision).toBe("allow");
    expect(classifyCommand("kubectl rollout status deploy/x").decision).toBe("allow");
    expect(classifyCommand("kubectl auth can-i get pods").decision).toBe("allow");
  });

  test("cluster mutations are denied with the action-block hint", () => {
    const v = classifyCommand("kubectl delete pod x");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/action block/i);
  });

  test("helm mutations are denied", () => {
    expect(classifyCommand("helm install affine ./chart").decision).toBe("deny");
  });

  test("a mutation hidden in a chain or wrapper is still denied", () => {
    expect(classifyCommand("kubectl get pods && kubectl delete pod x").decision).toBe("deny");
    expect(classifyCommand(`sh -c "kubectl delete pod x"`).decision).toBe("deny");
    expect(classifyCommand("xargs kubectl delete pod").decision).toBe("deny");
  });

  test("port-forward / proxy are blocked (cannot run headless)", () => {
    const v = classifyCommand("kubectl port-forward svc/x 8080:80");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/port-forward/i);
  });

  test("namespace value flag does not get mistaken for the verb", () => {
    expect(classifyCommand("kubectl -n personal get pods").decision).toBe("allow");
  });
});
