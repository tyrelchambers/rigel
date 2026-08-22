import { describe, test, expect } from "vitest";
import { classifyTier, classifyCommand, printsSecretValues } from "./commandPolicy";

describe("classifyTier", () => {
  test("reads are read tier", () => {
    expect(classifyTier("kubectl get pods -n default").tier).toBe("read");
    expect(classifyTier("kubectl logs foo | jq .status").tier).toBe("read");
    expect(classifyTier("kubectl auth can-i delete pods").tier).toBe("read");
    expect(classifyTier("kubectl rollout status deploy/api").tier).toBe("read");
  });

  test("reversible mutations are reversible tier", () => {
    for (const c of [
      "kubectl rollout restart deployment/api -n default",
      "kubectl scale deployment/api --replicas=3 -n default",
      "kubectl apply -f app.yaml",
      "kubectl patch deployment api -p '{}'",
      "kubectl set env deployment/api FOO=bar",
      "kubectl cordon node-1",
      "helm upgrade app ./chart",
    ]) {
      expect(classifyTier(c).tier).toBe("reversible");
    }
  });

  test("destructive mutations are destructive tier", () => {
    for (const c of [
      "kubectl delete pod foo -n default",
      "kubectl delete namespace payments",
      "kubectl drain node-1",
      "helm uninstall app",
    ]) {
      expect(classifyTier(c).tier).toBe("destructive");
    }
  });

  test("unknown mutation shapes bias to destructive", () => {
    // a wrapped delete must not slip through as reversible
    expect(classifyTier("sh -c 'kubectl delete pvc data-0'").tier).toBe("destructive");
    expect(classifyTier("xargs kubectl delete pod").tier).toBe("destructive");
  });

  test("port-forward/proxy are blocked", () => {
    expect(classifyTier("kubectl port-forward svc/api 8080:80").tier).toBe("blocked");
  });

  test("flag+value before the verb still finds the verb", () => {
    expect(classifyTier("kubectl -n prod delete pod foo").tier).toBe("destructive");
  });

  test("value flag before a read verb stays read", () => {
    expect(classifyTier("kubectl --context x get pods").tier).toBe("read");
  });

  test("a namespace VALUE named 'delete' is not mistaken for the verb", () => {
    expect(classifyTier("kubectl -n delete get pods").tier).toBe("read");
  });

  test("klog verbosity value flag doesn't swallow the verb", () => {
    expect(classifyTier("kubectl --v 5 delete pod foo").tier).toBe("destructive");
  });
});

describe("classifyCommand (2-tier compat)", () => {
  test("reads allow, mutations deny", () => {
    expect(classifyCommand("kubectl get pods").decision).toBe("allow");
    expect(classifyCommand("kubectl delete pod foo").decision).toBe("deny");
    expect(classifyCommand("kubectl scale deploy/api --replicas=2").decision).toBe("deny");
  });

  test("cross-context mutation gets the cross-context reason", () => {
    const v = classifyCommand("kubectl --context other delete pod foo", "active");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/DIFFERENT cluster/);
  });

  test("inline --context=value form triggers the cross-context steer", () => {
    expect(
      classifyCommand("kubectl --context=other delete pod foo", "active").reason,
    ).toMatch(/DIFFERENT cluster/);
  });

  test("fan-out READ on a non-active context still allows", () => {
    expect(
      classifyCommand("kubectl --context other get pods", "active").decision,
    ).toBe("allow");
  });

  test("mutation on the ACTIVE context uses the normal approval hint", () => {
    const v = classifyCommand("kubectl --context active delete pod foo", "active");
    expect(v.decision).toBe("deny");
    expect(v.reason).not.toMatch(/DIFFERENT cluster/);
  });
});

describe("printsSecretValues", () => {
  test("recognises every form that would print a value", () => {
    for (const command of [
      "kubectl get secret db -n default -o yaml",
      "kubectl get secrets -A -o json",
      "kubectl get secret db -o=jsonpath={.data.password}",
      "kubectl get secret db -o go-template={{.data}}",
      "kubectl get secret/db -o yaml",
    ]) {
      expect(printsSecretValues(command), command).toBe(true);
    }
  });

  test("leaves the shape readable, which is what redaction would have given anyway", () => {
    for (const command of [
      "kubectl describe secret db -n default",
      "kubectl get secret -n default",
      "kubectl get secrets -A",
    ]) {
      expect(printsSecretValues(command), command).toBe(false);
    }
  });

  test("does not touch reads of anything that is not a secret", () => {
    expect(printsSecretValues("kubectl get deployment web -o yaml")).toBe(false);
    expect(printsSecretValues("kubectl get configmap app-config -o yaml")).toBe(false);
  });

  // It is the caller's job to apply this, because the answer depends on whether
  // the caller can redact its own output. The voice read path redacts and so
  // allows these; only the chat shell, which cannot, refuses them.
  test("the shared classifier still calls a Secret read a read", () => {
    expect(classifyCommand("kubectl get secret db -o yaml", null)).toMatchObject({ decision: "allow" });
  });
});
