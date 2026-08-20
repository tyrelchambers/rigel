import { describe, expect, test } from "vitest";
import { decideMutationRoute } from "./mutationFlow.js";

describe("decideMutationRoute", () => {
  test("a proposal with a desktop attached goes to the desktop, whatever it is", () => {
    expect(decideMutationRoute("kubectl --context p rollout restart deployment/web", true)).toEqual({
      route: "click",
    });
    expect(decideMutationRoute("kubectl --context p delete pod web-1", true)).toEqual({ route: "click" });
  });

  test("no desktop present is refused with an explanation, since nothing else can run it", () => {
    const r = decideMutationRoute("kubectl --context p delete pod web-1", false);
    expect(r.route).toBe("refuse");
    expect(r).toHaveProperty("reason");
  });

  test("blocked commands are refused outright, desktop present or not", () => {
    expect(decideMutationRoute("kubectl port-forward svc/web 8080:80", true).route).toBe("refuse");
    expect(decideMutationRoute("kubectl port-forward svc/web 8080:80", false).route).toBe("refuse");
  });

  test("there is no route that runs a change without a tap", () => {
    const routes = new Set(
      ["kubectl get pods", "kubectl delete deployment web", "kubectl scale deployment/web --replicas=3"].flatMap(
        (cmd) => [decideMutationRoute(cmd, true).route, decideMutationRoute(cmd, false).route],
      ),
    );
    expect([...routes].sort()).toEqual(["click", "refuse"]);
  });
});
