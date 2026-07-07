import { describe, it, expect } from "vitest";
import { convert } from "./convert";
import { explainConversion } from "./explain";

const COMPOSE = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    environment:
      API_TOKEN: abc
    depends_on: [db]
  db:
    image: nginx:1.27
`;

describe("explainConversion", () => {
  const r = convert(COMPOSE, { namespace: "apps" });
  const explanation = explainConversion(r);

  it("summarizes total resources and app count with correct pluralization", () => {
    const total = r.manifests.length;
    const apps = r.manifests.filter((m) => m.kind === "Deployment").length;
    expect(explanation.summary).toBe(
      `Your Compose file becomes ${total} Kubernetes resources: ${apps} apps plus the networking and storage that keep them running.`,
    );
  });

  it("lists only the present kinds in fixed order with exact texts and correct counts", () => {
    expect(explanation.resources).toEqual([
      { kind: "Deployment", count: 2, text: "Run your app containers and restart any that crash." },
      {
        kind: "Service",
        count: 1,
        text: "Give your apps stable in-cluster addresses so they can reach each other by name.",
      },
    ]);
  });

  it("flags expose, emitSecrets, and addWaitInit attention lines", () => {
    expect(explanation.attention).toEqual([
      "Your apps' ports are internal-only right now. Use a port's Fix (LoadBalancer or Ingress) to reach them from outside the cluster.",
      "Some values look like passwords. Use Fix to have Rigel create a Secret to hold them, or create it yourself before applying.",
      "Kubernetes starts everything at once. Use Fix to make dependents wait for what they need.",
    ]);
  });

  it("drops attention lines and adds the Secret resource once fixes are applied", () => {
    const fixed = convert(COMPOSE, {
      namespace: "apps",
      fixes: { expose: "loadbalancer", emitSecrets: true, addWaitInit: true },
    });
    const explanation2 = explainConversion(fixed);
    expect(explanation2.attention).toEqual([]);
    expect(explanation2.resources.map((r) => r.kind)).toContain("Secret");
    const secretEntry = explanation2.resources.find((r) => r.kind === "Secret");
    expect(secretEntry).toEqual({
      kind: "Secret",
      count: 1,
      text: "Hold sensitive values like passwords and tokens, separate from your app config.",
    });
  });

  it("singularizes the summary for a single resource and single app", () => {
    const single = convert("services:\n  web:\n    image: nginx:1.27\n", { namespace: "apps" });
    const e = explainConversion(single);
    expect(single.manifests.length).toBe(1);
    expect(e.summary).toBe(
      "Your Compose file becomes 1 Kubernetes resource: 1 app plus the networking and storage that keep them running.",
    );
  });

  it("returns an empty explanation for an empty compose file", () => {
    const empty = convert("services: {}\n", { namespace: "apps" });
    expect(empty.manifests).toEqual([]);
    const e = explainConversion(empty);
    expect(e.summary).toBe("");
    expect(e.resources).toEqual([]);
    expect(e.attention).toEqual([]);
  });
});
