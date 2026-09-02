import { describe, it, expect } from "vitest";
import { storageRules } from "./storage";

function pvc(over: Record<string, any> = {}): Record<string, any> {
  return {
    metadata: { name: "data", namespace: "default", creationTimestamp: "2026-01-01T00:00:00Z" },
    spec: {},
    status: { phase: "Bound" },
    ...over,
  };
}

function pv(over: Record<string, any> = {}): Record<string, any> {
  return {
    metadata: { name: "pv-0" },
    spec: {},
    status: { phase: "Bound" },
    ...over,
  };
}

function quota(hard: Record<string, string>, used: Record<string, string>): Record<string, any> {
  return {
    metadata: { name: "team", namespace: "default" },
    status: { hard, used },
  };
}

describe("pvcUnbound", () => {
  it("fires on a Pending claim", () => {
    const out = storageRules({ persistentvolumeclaims: [pvc({ status: { phase: "Pending" } })] });
    expect(out.map((i) => i.rule)).toEqual(["pvcUnbound"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({
      kind: "PersistentVolumeClaim",
      namespace: "default",
      name: "data",
    });
    expect(out[0].onsetAt).toBe("2026-01-01T00:00:00Z");
  });

  it("does not fire on a Bound claim", () => {
    expect(storageRules({ persistentvolumeclaims: [pvc()] })).toEqual([]);
  });
});

describe("pvcMissingStorageClass", () => {
  it("fires when the named StorageClass does not exist", () => {
    const out = storageRules({
      persistentvolumeclaims: [pvc({ spec: { storageClassName: "fast" } })],
      storageclasses: [{ metadata: { name: "slow" } }],
    });
    expect(out.map((i) => i.rule)).toEqual(["pvcMissingStorageClass"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].related).toContainEqual({
      kind: "StorageClass",
      namespace: "",
      name: "fast",
    });
  });

  it("does not fire when the StorageClass exists", () => {
    const out = storageRules({
      persistentvolumeclaims: [pvc({ spec: { storageClassName: "fast" } })],
      storageclasses: [{ metadata: { name: "fast" } }],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when storage classes were not watched", () => {
    const out = storageRules({
      persistentvolumeclaims: [pvc({ spec: { storageClassName: "fast" } })],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when the claim opts out of a storage class", () => {
    const out = storageRules({
      persistentvolumeclaims: [pvc({ spec: { storageClassName: "" } })],
      storageclasses: [],
    });
    expect(out).toEqual([]);
  });
});

describe("pvFailed", () => {
  it("fires on a Failed volume and quotes the Kubernetes message", () => {
    const out = storageRules({
      persistentvolumes: [
        pv({ status: { phase: "Failed", message: "host path deletion failed" } }),
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["pvFailed"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].evidence).toBe("host path deletion failed");
    expect(out[0].subject).toEqual({ kind: "PersistentVolume", namespace: "", name: "pv-0" });
  });

  it("does not fire on a Bound volume", () => {
    expect(storageRules({ persistentvolumes: [pv()] })).toEqual([]);
  });
});

describe("pvReleased", () => {
  it("fires on a Released volume", () => {
    const out = storageRules({ persistentvolumes: [pv({ status: { phase: "Released" } })] });
    expect(out.map((i) => i.rule)).toEqual(["pvReleased"]);
    expect(out[0].severity).toBe("info");
    expect(out[0].evidence).toBeUndefined();
  });

  it("does not fire on an Available volume", () => {
    expect(storageRules({ persistentvolumes: [pv({ status: { phase: "Available" } })] })).toEqual(
      [],
    );
  });
});

describe("resourceQuotaExhausted", () => {
  it("fires when used has reached hard", () => {
    const out = storageRules({
      resourcequotas: [quota({ "requests.memory": "10Gi" }, { "requests.memory": "10Gi" })],
    });
    expect(out.map((i) => i.rule)).toEqual(["resourceQuotaExhausted"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].subject).toEqual({
      kind: "ResourceQuota",
      namespace: "default",
      name: "team",
    });
  });

  it("does not fire when used is below hard", () => {
    const out = storageRules({
      resourcequotas: [quota({ "requests.memory": "10Gi" }, { "requests.memory": "4Gi" })],
    });
    expect(out).toEqual([]);
  });

  it("compares CPU quantities in cores", () => {
    const fires = storageRules({
      resourcequotas: [quota({ "requests.cpu": "1" }, { "requests.cpu": "1500m" })],
    });
    expect(fires.map((i) => i.rule)).toEqual(["resourceQuotaExhausted"]);
    const quiet = storageRules({
      resourcequotas: [quota({ "requests.cpu": "2" }, { "requests.cpu": "1500m" })],
    });
    expect(quiet).toEqual([]);
  });

  it("names every exhausted resource in one issue", () => {
    const out = storageRules({
      resourcequotas: [
        quota({ pods: "10", "requests.memory": "10Gi" }, { pods: "10", "requests.memory": "10Gi" }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].whatsWrong).toContain("pods");
    expect(out[0].whatsWrong).toContain("requests.memory");
  });

  it("does not fire when a hard limit has no matching used value", () => {
    const out = storageRules({ resourcequotas: [quota({ pods: "10" }, {})] });
    expect(out).toEqual([]);
  });
});
