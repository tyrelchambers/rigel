import { test, expect, describe } from "vitest";
import { classifyCommand } from "./commandPolicy";

const allow = (cmd: string) => expect(classifyCommand(cmd).decision).toBe("allow");
const deny = (cmd: string) => expect(classifyCommand(cmd).decision).toBe("deny");

describe("classifyCommand — reads run regardless of flag order", () => {
  test("plain reads", () => {
    allow("kubectl get pods -o wide");
    allow("kubectl describe deployment affine");
    allow("kubectl logs affine-xyz");
    allow("kubectl top pods");
    allow("kubectl events -n personal");
  });

  test("context/namespace flags BEFORE the verb (the bug that broke the allowlist)", () => {
    allow("kubectl --context default -n personal get deployment affine -o wide");
    allow("kubectl --context default -n personal get pods -o wide");
    allow("kubectl -n personal --context default get svc postgres -o yaml");
    allow("kubectl --namespace personal get statefulset postgres");
  });

  test("rollout status / history and auth can-i are reads despite mutating parent verb", () => {
    allow("kubectl --context default -n personal rollout status deployment/affine --timeout=5s");
    allow("kubectl rollout history deployment/affine");
    allow("kubectl auth can-i get pods");
  });

  test("pipes, chains, separators, echo/cat probes", () => {
    allow("kubectl get svc postgres -o yaml | grep -A6 selector:");
    allow('kubectl get ns 2>&1; echo "---PG---"; kubectl get pods -A | head -30');
    allow("kubectl get sts postgres -o yaml | grep -E 'name:|labels:' | head -40");
    allow("cat /root/.kube/config");
  });

  test("non kubectl/helm tooling is allowed", () => {
    allow("jq '.items[].metadata.name'");
    allow("awk '{print $1}'");
    allow('echo "exit: $?"');
    allow("helm list -A");
    allow("helm status affine -n personal");
    allow("helm get values affine -n personal");
  });
});

describe("classifyCommand — cluster mutations are denied (→ approval)", () => {
  test("kubectl mutating verbs", () => {
    deny("kubectl delete pod affine-xyz -n personal");
    deny("kubectl --context default -n personal patch svc postgres -p '{\"spec\":{}}'");
    deny("kubectl apply -f manifest.yaml");
    deny("kubectl scale deployment affine --replicas=0");
    deny("kubectl rollout restart deployment/affine");
    deny("kubectl rollout undo deployment/affine");
    deny("kubectl annotate svc postgres foo=bar");
    deny("kubectl edit deployment affine");
    deny("kubectl -n personal exec affine-xyz -- sh -c 'rm -rf /'");
    deny("kubectl auth reconcile -f rbac.yaml");
  });

  test("flag-reordered mutation still denied (no false negative)", () => {
    deny("kubectl -n delete --context default delete pod x"); // ns literally 'delete'
    deny("kubectl --namespace personal --context default delete svc postgres");
  });

  test("helm mutating verbs", () => {
    deny("helm install affine ./chart -n personal");
    deny("helm upgrade affine ./chart");
    deny("helm uninstall affine -n personal");
    deny("helm rollback affine 1");
  });

  test("mutation anywhere in a pipe/chain denies the whole command", () => {
    deny("kubectl get pods | xargs kubectl delete pod");
    deny('echo ok && kubectl delete ns personal');
    deny("kubectl get x -o name | xargs -I{} kubectl delete {}");
  });

  test("mutation hidden in command substitution is caught", () => {
    deny("echo $(kubectl delete pod x -n personal)");
    deny("X=`kubectl scale deploy a --replicas=0`");
  });

  test("piped apply (the classic exfil-to-apply) is denied", () => {
    deny("kubectl get cm foo -o yaml | kubectl apply -f -");
  });
});

describe("classifyCommand — port-forward/proxy blocked (would hang the turn)", () => {
  test("denied with the use-the-app reason, not the action-block reason", () => {
    const pf = classifyCommand("kubectl --context default -n personal port-forward svc/affine 3010:3010");
    expect(pf.decision).toBe("deny");
    expect(pf.reason).toMatch(/built-in port-forward/i);
    deny("kubectl proxy --port=8001");
  });
  test("a real mutation in the same command still wins (action-block reason)", () => {
    const v = classifyCommand("kubectl port-forward svc/x 1:1 && kubectl delete pod y");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/action block/i);
  });
});

describe("classifyCommand — cross-context mutation safety (multi-cluster fan-out)", () => {
  test("a mutation targeting a NON-active explicit context is denied with the cross-cluster reason", () => {
    const v = classifyCommand("kubectl --context prod delete pod web", "dev");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/active cluster/i);
    expect(v.reason).toContain("dev");
  });

  test("--context=value inline form is detected for cross-context mutations", () => {
    expect(classifyCommand("kubectl --context=prod scale deploy/web --replicas=0", "dev").reason).toMatch(/active cluster/i);
  });

  test("a mutation on the ACTIVE context uses the normal approval hint (not cross-cluster)", () => {
    const v = classifyCommand("kubectl --context dev delete pod web", "dev");
    expect(v.decision).toBe("deny");
    expect(v.reason).not.toMatch(/active cluster/i);
  });

  test("a READ on a non-active context is still allowed (fan-out reads are fine)", () => {
    expect(classifyCommand("kubectl --context prod get pods", "dev").decision).toBe("allow");
  });

  test("a mutation with no explicit context is denied normally (no cross-cluster reason)", () => {
    expect(classifyCommand("kubectl delete pod web", "dev").reason).not.toMatch(/active cluster/i);
  });

  test("without an activeContext the cross-cluster check is inert (back-compat)", () => {
    expect(classifyCommand("kubectl --context prod delete pod web").reason).not.toMatch(/active cluster/i);
  });

  test("a mutation referencing ANY non-active context (even alongside the active one) is denied cross-cluster", () => {
    // Conservative: if a mutation names any cluster other than the active one, deny.
    const v = classifyCommand("kubectl --context dev --context prod delete pod web", "dev");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/active cluster/i);
  });
});
