import { describe, expect, test } from "vitest";
import type { CatalogApp, SecretFieldSpec } from "@helmsman/catalog";
import type { Pod } from "../pods/types";
import {
  canAdvanceFromConfigure,
  templateVars,
  renderArtifact,
  resolveSecretSpecs,
  initialSecretValues,
  secretsComplete,
  matchInstancePods,
  podReadiness,
  type ConfigureValues,
} from "./wizardLogic";

function app(partial: Partial<CatalogApp> & { id: string }): CatalogApp {
  return {
    name: partial.id,
    tagline: "",
    description: "",
    category: "other",
    iconSystemName: "x",
    docsURL: "https://x",
    tags: [],
    matchImages: [],
    requirements: { cpuRequest: "100m", memoryRequest: "128Mi" },
    persistence: false,
    exposesIngress: false,
    installPromptTemplate: "",
    ...partial,
  } as CatalogApp;
}

const baseConfig: ConfigureValues = {
  instance: "vw",
  namespace: "default",
  hostname: "",
  nodePin: null,
  storageGiB: 0,
  clusterIssuer: "",
  notes: "",
};

describe("canAdvanceFromConfigure", () => {
  test("requires instance and namespace", () => {
    const a = app({ id: "x" });
    expect(canAdvanceFromConfigure(a, baseConfig)).toBe(true);
    expect(canAdvanceFromConfigure(a, { ...baseConfig, instance: "  " })).toBe(false);
    expect(canAdvanceFromConfigure(a, { ...baseConfig, namespace: "" })).toBe(false);
  });

  test("requires hostname when exposesIngress", () => {
    const a = app({ id: "x", exposesIngress: true });
    expect(canAdvanceFromConfigure(a, baseConfig)).toBe(false);
    expect(canAdvanceFromConfigure(a, { ...baseConfig, hostname: "x.example.com" })).toBe(true);
  });

  test("requires storage > 0 when persistent", () => {
    const a = app({ id: "x", persistence: true });
    expect(canAdvanceFromConfigure(a, baseConfig)).toBe(false);
    expect(canAdvanceFromConfigure(a, { ...baseConfig, storageGiB: 5 })).toBe(true);
  });
});

describe("templateVars", () => {
  test("includes derived redirectMiddleware and nodeName fallback", () => {
    const vars = templateVars({ ...baseConfig, instance: "vw", storageGiB: 10 });
    expect(vars.instance).toBe("vw");
    expect(vars.nodeName).toBe("");
    expect(vars.storage).toBe("10");
    expect(vars.redirectMiddleware).toBe("vw-redirect");
  });
});

describe("renderArtifact", () => {
  test("substitutes manifest vars", () => {
    const a = app({
      id: "x",
      install: { mode: "manifest", manifest: "name: {{instance}}\nns: {{namespace}}" },
    });
    expect(renderArtifact(a, templateVars(baseConfig))).toBe("name: vw\nns: default");
  });

  test("returns null for not-baked app", () => {
    const a = app({ id: "x" });
    expect(renderArtifact(a, templateVars(baseConfig))).toBeNull();
  });
});

describe("resolveSecretSpecs", () => {
  test("uses declared secrets when present", () => {
    const declared: SecretFieldSpec[] = [{ key: "PW", label: "Password", kind: "random" }];
    const a = app({ id: "x", install: { mode: "manifest", secrets: declared } });
    expect(resolveSecretSpecs(a, "kind: Secret\nstringData:\n  TOKEN: <FILL_ME_IN>")).toBe(declared);
  });

  test("synthesizes user fields from scanned placeholders", () => {
    const a = app({ id: "x", install: { mode: "manifest" } });
    const specs = resolveSecretSpecs(a, "kind: Secret\nstringData:\n  TOKEN: <FILL_ME_IN>");
    expect(specs).toEqual([{ key: "TOKEN", label: "TOKEN", kind: "user", required: true }]);
  });
});

describe("initialSecretValues / secretsComplete", () => {
  test("random pre-filled, user empty, required gates", () => {
    const specs: SecretFieldSpec[] = [
      { key: "RAND", label: "r", kind: "random", length: 16 },
      { key: "USER", label: "u", kind: "user", required: true },
    ];
    const values = initialSecretValues(specs);
    expect(values.RAND.length).toBe(16);
    expect(values.USER).toBe("");
    expect(secretsComplete(specs, values)).toBe(false);
    expect(secretsComplete(specs, { ...values, USER: "x" })).toBe(true);
  });

  test("optional user field does not gate", () => {
    const specs: SecretFieldSpec[] = [{ key: "OPT", label: "o", kind: "user", required: false }];
    expect(secretsComplete(specs, { OPT: "" })).toBe(true);
  });
});

// --- verifying -------------------------------------------------------------

function pod(
  name: string,
  opts: {
    namespace?: string;
    instance?: string;
    phase?: string;
    ready?: boolean;
    restarts?: number;
    waitingReason?: string;
  },
): Pod {
  return {
    metadata: {
      name,
      namespace: opts.namespace ?? "default",
      uid: name,
      labels: opts.instance ? { "app.kubernetes.io/instance": opts.instance } : {},
    },
    spec: { containers: [{ name: "c" }] },
    status: {
      phase: opts.phase ?? "Running",
      containerStatuses: [
        {
          name: "c",
          ready: opts.ready ?? true,
          restartCount: opts.restarts ?? 0,
          state: opts.waitingReason ? { waiting: { reason: opts.waitingReason } } : undefined,
        },
      ],
    },
  };
}

describe("matchInstancePods", () => {
  test("matches namespace + instance label", () => {
    const pods = [
      pod("a", { namespace: "apps", instance: "vw" }),
      pod("b", { namespace: "apps", instance: "other" }),
      pod("c", { namespace: "default", instance: "vw" }),
    ];
    expect(matchInstancePods(pods, "apps", "vw").map((p) => p.metadata.name)).toEqual(["a"]);
  });
});

describe("podReadiness", () => {
  test("creating when no pods", () => {
    expect(podReadiness([]).state).toBe("creating");
  });
  test("ready when all running+ready", () => {
    const r = podReadiness([pod("a", { ready: true }), pod("b", { ready: true })]);
    expect(r.state).toBe("ready");
    expect(r.ready).toBe(2);
    expect(r.total).toBe(2);
  });
  test("starting when some not ready", () => {
    const r = podReadiness([pod("a", { ready: true }), pod("b", { ready: false })]);
    expect(r.state).toBe("starting");
    expect(r.ready).toBe(1);
  });
  test("failed on crashloop", () => {
    const r = podReadiness([pod("a", { ready: false, waitingReason: "CrashLoopBackOff" })]);
    expect(r.state).toBe("failed");
  });
  test("tracks max restarts", () => {
    const r = podReadiness([pod("a", { ready: false, restarts: 4 })]);
    expect(r.maxRestarts).toBe(4);
  });
});
