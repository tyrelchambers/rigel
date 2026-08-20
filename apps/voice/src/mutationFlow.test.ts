import { ACTION_KINDS, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { describe, expect, test } from "vitest";
import { decideMutationRoute } from "./mutationFlow.js";

const restart: SuggestedAction = { kind: "restart", label: "Restart web", name: "web" };
const del: SuggestedAction = { kind: "deletePod", label: "Delete web-1", pod: "web-1" };

describe("decideMutationRoute", () => {
  test("a non-destructive change the operator asked for is run", () => {
    expect(decideMutationRoute(restart, "kubectl --context p rollout restart deployment/web", true)).toEqual({
      route: "run",
    });
  });

  test("a destructive kind is surfaced for approval instead", () => {
    expect(decideMutationRoute(del, "kubectl --context p delete pod web-1", true)).toEqual({ route: "click" });
  });

  test("running does not need a desktop, but approval does", () => {
    expect(decideMutationRoute(restart, "kubectl --context p rollout restart deployment/web", false).route).toBe(
      "run",
    );
    const r = decideMutationRoute(del, "kubectl --context p delete pod web-1", false);
    expect(r.route).toBe("refuse");
    expect(r).toHaveProperty("reason");
  });

  test("the classifier beats the kind table: an auto kind whose command deletes is surfaced", () => {
    expect(decideMutationRoute(restart, "kubectl --context p delete deployment web", true).route).toBe("click");
  });

  test("a destructive command chained onto a safe one still needs approval", () => {
    expect(
      decideMutationRoute(
        restart,
        "kubectl --context p rollout restart deployment/web && kubectl --context p delete pod web-1",
        true,
      ).route,
    ).toBe("click");
  });

  test("the model's destructive hint downgrades an auto kind to approval", () => {
    expect(
      decideMutationRoute({ ...restart, destructive: true }, "kubectl --context p rollout restart deployment/web", true)
        .route,
    ).toBe("click");
  });

  test("blocked commands are refused outright, desktop present or not", () => {
    const pf: SuggestedAction = { kind: "command", label: "pf", args: ["port-forward", "svc/web", "8080:80"] };
    expect(decideMutationRoute(pf, "kubectl port-forward svc/web 8080:80", true).route).toBe("refuse");
    expect(decideMutationRoute(pf, "kubectl port-forward svc/web 8080:80", false).route).toBe("refuse");
  });

  test("no kind ever runs itself when its command deletes something", () => {
    for (const kind of ACTION_KINDS) {
      const route = decideMutationRoute(
        { kind, label: kind } as SuggestedAction,
        "kubectl delete deployment web",
        true,
      ).route;
      expect(route).toBe("click");
    }
  });
});
