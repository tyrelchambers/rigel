import { ACTION_KINDS, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { describe, expect, test } from "vitest";
import { decideMutationRoute, isPendingLive, PENDING_TTL_MS } from "./mutationFlow.js";

const restart: SuggestedAction = { kind: "restart", label: "Restart web", name: "web" };
const del: SuggestedAction = { kind: "deletePod", label: "Delete web-1", name: "web-1", pod: "web-1" };

describe("decideMutationRoute", () => {
  test("a reversible voice-kind routes to voice", () => {
    expect(
      decideMutationRoute(restart, "kubectl --context p rollout restart deployment/web", true),
    ).toEqual({ route: "voice" });
  });

  test("an irreversible kind routes to click when a desktop is present", () => {
    expect(decideMutationRoute(del, "kubectl --context p delete pod web-1", true)).toEqual({ route: "click" });
  });

  test("irreversible with no desktop present is refused with an explanation", () => {
    const r = decideMutationRoute(del, "kubectl --context p delete pod web-1", false);
    expect(r.route).toBe("refuse");
    expect(r).toHaveProperty("reason");
  });

  test("the classifier verdict beats the kind table (a voice kind whose command tiers destructive goes to click)", () => {
    expect(decideMutationRoute(restart, "kubectl --context p delete deployment web", true).route).toBe("click");
  });

  test("a destructive command chained onto a reversible one still tiers destructive", () => {
    expect(
      decideMutationRoute(
        restart,
        "kubectl --context p rollout restart deployment/web && kubectl --context p delete pod web-1",
        true,
      ).route,
    ).toBe("click");
  });

  test("the model's destructive hint downgrades a voice kind to click", () => {
    const hinted: SuggestedAction = { ...restart, destructive: true };
    expect(decideMutationRoute(hinted, "kubectl --context p rollout restart deployment/web", true).route).toBe(
      "click",
    );
  });

  test("blocked commands are refused outright, desktop present or not", () => {
    const pf: SuggestedAction = {
      kind: "command",
      label: "pf",
      args: ["port-forward", "svc/web", "8080:80"],
    };
    expect(decideMutationRoute(pf, "kubectl port-forward svc/web 8080:80", true).route).toBe("refuse");
    expect(decideMutationRoute(pf, "kubectl port-forward svc/web 8080:80", false).route).toBe("refuse");
  });

  test("every action kind resolves to exactly one route, and voice never falls out of a delete command", () => {
    for (const kind of ACTION_KINDS) {
      const reversible = decideMutationRoute({ kind, label: kind } as SuggestedAction, "kubectl get pods", true);
      expect(["voice", "click", "refuse"]).toContain(reversible.route);

      const destructive = decideMutationRoute(
        { kind, label: kind } as SuggestedAction,
        "kubectl delete deployment web",
        true,
      );
      expect(destructive.route).toBe("click");
    }
  });
});

describe("isPendingLive", () => {
  const pending = { id: "1", action: restart, command: "c", armedAt: 1000 };

  test("live within the TTL, dead after", () => {
    expect(isPendingLive(pending, 1000)).toBe(true);
    expect(isPendingLive(pending, 1000 + PENDING_TTL_MS)).toBe(true);
    expect(isPendingLive(pending, 1001 + PENDING_TTL_MS)).toBe(false);
  });

  test("an empty slot is never live", () => {
    expect(isPendingLive(null, 1000)).toBe(false);
  });
});
