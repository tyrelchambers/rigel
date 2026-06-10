import { describe, expect, test } from "vitest";
import type {
  PersistentVolumeClaim,
  PersistentVolume,
  StorageClass,
} from "./types";
import {
  abbreviateAccessModes,
  storagePhaseColor,
  isDefaultStorageClass,
  claimRef,
  matchesSearch,
  pvcPhase,
  pvcAccessModes,
  pvcCapacity,
  pvPhase,
  pvCapacity,
  matchesPVC,
  matchesPV,
  matchesStorageClass,
  sortPVCs,
  sortPVs,
  sortStorageClasses,
} from "./storageDisplay";

function pvc(overrides: Partial<PersistentVolumeClaim> = {}): PersistentVolumeClaim {
  return {
    metadata: { name: "claim", namespace: "default", uid: "u1", ...overrides.metadata },
    spec: overrides.spec,
    status: overrides.status,
  };
}

function pv(overrides: Partial<PersistentVolume> = {}): PersistentVolume {
  return {
    metadata: { name: "vol", uid: "u1", ...overrides.metadata },
    spec: overrides.spec,
    status: overrides.status,
  };
}

function sc(overrides: Partial<StorageClass> = {}): StorageClass {
  return {
    metadata: { name: "sc", uid: "u1", ...overrides.metadata },
    provisioner: overrides.provisioner,
    reclaimPolicy: overrides.reclaimPolicy,
    volumeBindingMode: overrides.volumeBindingMode,
    allowVolumeExpansion: overrides.allowVolumeExpansion,
  };
}

describe("abbreviateAccessModes", () => {
  test("maps the four known modes", () => {
    expect(
      abbreviateAccessModes([
        "ReadWriteOnce",
        "ReadOnlyMany",
        "ReadWriteMany",
        "ReadWriteOncePod",
      ]),
    ).toEqual(["RWO", "ROX", "RWX", "RWOP"]);
  });
  test("passes unknown modes through unchanged", () => {
    expect(abbreviateAccessModes(["Weird", "ReadWriteOnce"])).toEqual([
      "Weird",
      "RWO",
    ]);
  });
  test("applies even for a single mode", () => {
    expect(abbreviateAccessModes(["ReadWriteMany"])).toEqual(["RWX"]);
  });
  test("empty input", () => {
    expect(abbreviateAccessModes([])).toEqual([]);
  });
});

describe("storagePhaseColor", () => {
  const GREEN = "bg-green-500/15 text-green-600 dark:text-green-400";
  const AMBER = "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400";
  const RED = "bg-red-500/15 text-red-600 dark:text-red-400";
  const GRAY = "bg-muted text-muted-foreground";
  test("Bound and Available are green (running)", () => {
    expect(storagePhaseColor("Bound")).toBe(GREEN);
    expect(storagePhaseColor("Available")).toBe(GREEN);
  });
  test("Pending is amber (pending)", () => {
    expect(storagePhaseColor("Pending")).toBe(AMBER);
  });
  test("Lost and Failed are red (failed)", () => {
    expect(storagePhaseColor("Lost")).toBe(RED);
    expect(storagePhaseColor("Failed")).toBe(RED);
  });
  test("Released falls through to gray default", () => {
    // Released is a PV-only red in the spec prose but the color map only colors
    // Lost/Failed red; per §9 unknown phases use the tertiary gray default.
    expect(storagePhaseColor("Released")).toBe(GRAY);
  });
  test("unknown phase falls through to gray default", () => {
    expect(storagePhaseColor("Corrupt")).toBe(GRAY);
    expect(storagePhaseColor("Unknown")).toBe(GRAY);
    expect(storagePhaseColor("")).toBe(GRAY);
  });
});

describe("isDefaultStorageClass", () => {
  test('true only when annotation == "true"', () => {
    expect(
      isDefaultStorageClass(
        sc({
          metadata: {
            name: "fast",
            annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
          },
        }),
      ),
    ).toBe(true);
  });
  test('false when annotation is "false"', () => {
    expect(
      isDefaultStorageClass(
        sc({
          metadata: {
            name: "fast",
            annotations: { "storageclass.kubernetes.io/is-default-class": "false" },
          },
        }),
      ),
    ).toBe(false);
  });
  test("false when annotation missing", () => {
    expect(isDefaultStorageClass(sc())).toBe(false);
    expect(isDefaultStorageClass(sc({ metadata: { name: "x", annotations: {} } }))).toBe(false);
  });
});

describe("claimRef", () => {
  test("formats namespace/name", () => {
    expect(claimRef(pv({ spec: { claimRef: { namespace: "shop", name: "data" } } }))).toBe(
      "shop/data",
    );
  });
  test("defaults namespace to 'default' when missing", () => {
    expect(claimRef(pv({ spec: { claimRef: { name: "data" } } }))).toBe("default/data");
  });
  test("null when no claimRef", () => {
    expect(claimRef(pv())).toBeNull();
    expect(claimRef(pv({ spec: {} }))).toBeNull();
  });
  test("null when claimRef has no name", () => {
    expect(claimRef(pv({ spec: { claimRef: { namespace: "shop" } } }))).toBeNull();
  });
});

describe("matchesSearch", () => {
  test("blank/whitespace query matches all", () => {
    expect(matchesSearch(["foo"], "")).toBe(true);
    expect(matchesSearch(["foo"], "   ")).toBe(true);
  });
  test("case-insensitive substring on joined haystack", () => {
    expect(matchesSearch(["Frontend", "shop"], "FRONT")).toBe(true);
    expect(matchesSearch(["Frontend", "shop"], "shop")).toBe(true);
  });
  test("skips undefined and null fields", () => {
    expect(matchesSearch([undefined, "bar", null], "bar")).toBe(true);
    expect(matchesSearch([undefined, null], "bar")).toBe(false);
  });
  test("no match returns false", () => {
    expect(matchesSearch(["foo", "bar"], "zzz")).toBe(false);
  });
});

describe("pvc field extraction", () => {
  test("pvcPhase defaults to Unknown", () => {
    expect(pvcPhase(pvc())).toBe("Unknown");
    expect(pvcPhase(pvc({ status: { phase: "Bound" } }))).toBe("Bound");
  });
  test("pvcAccessModes prefers status over spec", () => {
    expect(
      pvcAccessModes(
        pvc({
          spec: { accessModes: ["ReadWriteMany"] },
          status: { accessModes: ["ReadWriteOnce"] },
        }),
      ),
    ).toEqual(["ReadWriteOnce"]);
  });
  test("pvcAccessModes falls back to spec", () => {
    expect(pvcAccessModes(pvc({ spec: { accessModes: ["ReadWriteMany"] } }))).toEqual([
      "ReadWriteMany",
    ]);
  });
  test("pvcAccessModes empty when none", () => {
    expect(pvcAccessModes(pvc())).toEqual([]);
  });
  test("pvcCapacity prefers status.capacity then request then dash", () => {
    expect(
      pvcCapacity(
        pvc({
          spec: { resources: { requests: { storage: "5Gi" } } },
          status: { capacity: { storage: "10Gi" } },
        }),
      ),
    ).toBe("10Gi");
    expect(pvcCapacity(pvc({ spec: { resources: { requests: { storage: "5Gi" } } } }))).toBe(
      "5Gi",
    );
    expect(pvcCapacity(pvc())).toBe("—");
  });
  test("pvcCapacity displays quantity as-is (no normalization)", () => {
    expect(pvcCapacity(pvc({ status: { capacity: { storage: "1048576Ki" } } }))).toBe(
      "1048576Ki",
    );
  });
});

describe("pv field extraction", () => {
  test("pvPhase defaults to Unknown", () => {
    expect(pvPhase(pv())).toBe("Unknown");
    expect(pvPhase(pv({ status: { phase: "Released" } }))).toBe("Released");
  });
  test("pvCapacity or dash", () => {
    expect(pvCapacity(pv({ spec: { capacity: { storage: "100Gi" } } }))).toBe("100Gi");
    expect(pvCapacity(pv())).toBe("—");
  });
});

describe("matchesPVC", () => {
  const claim = pvc({
    metadata: { name: "data-postgres-0", namespace: "shop", uid: "u1" },
    spec: { storageClassName: "fast-ssd", volumeName: "pvc-abc123" },
    status: { phase: "Bound" },
  });
  test("matches name / namespace / storageClass / volumeName / phase", () => {
    expect(matchesPVC(claim, "postgres")).toBe(true);
    expect(matchesPVC(claim, "shop")).toBe(true);
    expect(matchesPVC(claim, "fast-ssd")).toBe(true);
    expect(matchesPVC(claim, "pvc-abc")).toBe(true);
    expect(matchesPVC(claim, "bound")).toBe(true);
  });
  test("no storageClassName: still searchable on other fields", () => {
    expect(matchesPVC(pvc({ metadata: { name: "c", namespace: "ns", uid: "u" } }), "c")).toBe(
      true,
    );
  });
  test("no match", () => {
    expect(matchesPVC(claim, "zzz")).toBe(false);
  });
});

describe("matchesPV", () => {
  const vol = pv({
    metadata: { name: "pvc-abc123", uid: "u1" },
    spec: {
      storageClassName: "fast-ssd",
      persistentVolumeReclaimPolicy: "Retain",
      claimRef: { namespace: "shop", name: "data" },
    },
    status: { phase: "Bound" },
  });
  test("matches name / storageClass / claimRef / phase / reclaimPolicy", () => {
    expect(matchesPV(vol, "pvc-abc")).toBe(true);
    expect(matchesPV(vol, "fast-ssd")).toBe(true);
    expect(matchesPV(vol, "shop/data")).toBe(true);
    expect(matchesPV(vol, "bound")).toBe(true);
    expect(matchesPV(vol, "retain")).toBe(true);
  });
  test("no claimRef: claim clause skipped, others still work", () => {
    expect(matchesPV(pv({ metadata: { name: "free-vol", uid: "u" } }), "free")).toBe(true);
  });
  test("no match", () => {
    expect(matchesPV(vol, "zzz")).toBe(false);
  });
});

describe("matchesStorageClass", () => {
  const clazz = sc({
    metadata: { name: "fast-ssd", uid: "u1" },
    provisioner: "ebs.csi.aws.com",
    reclaimPolicy: "Delete",
    volumeBindingMode: "WaitForFirstConsumer",
  });
  test("matches name / provisioner / reclaimPolicy / volumeBindingMode", () => {
    expect(matchesStorageClass(clazz, "fast")).toBe(true);
    expect(matchesStorageClass(clazz, "ebs.csi")).toBe(true);
    expect(matchesStorageClass(clazz, "delete")).toBe(true);
    expect(matchesStorageClass(clazz, "waitforfirst")).toBe(true);
  });
  test("missing provisioner: clause skipped, name still works", () => {
    expect(matchesStorageClass(sc({ metadata: { name: "local", uid: "u" } }), "local")).toBe(
      true,
    );
  });
  test("no match", () => {
    expect(matchesStorageClass(clazz, "zzz")).toBe(false);
  });
});

describe("sorting", () => {
  test("sortPVCs by namespace then name", () => {
    const items = [
      pvc({ metadata: { name: "b", namespace: "ns2", uid: "1" } }),
      pvc({ metadata: { name: "a", namespace: "ns2", uid: "2" } }),
      pvc({ metadata: { name: "z", namespace: "ns1", uid: "3" } }),
    ];
    expect(sortPVCs(items).map((p) => `${p.metadata.namespace}/${p.metadata.name}`)).toEqual([
      "ns1/z",
      "ns2/a",
      "ns2/b",
    ]);
  });
  test("sortPVs by name only", () => {
    const items = [
      pv({ metadata: { name: "c", uid: "1" } }),
      pv({ metadata: { name: "a", uid: "2" } }),
      pv({ metadata: { name: "b", uid: "3" } }),
    ];
    expect(sortPVs(items).map((p) => p.metadata.name)).toEqual(["a", "b", "c"]);
  });
  test("sortStorageClasses by name only", () => {
    const items = [
      sc({ metadata: { name: "slow", uid: "1" } }),
      sc({ metadata: { name: "fast", uid: "2" } }),
    ];
    expect(sortStorageClasses(items).map((s) => s.metadata.name)).toEqual(["fast", "slow"]);
  });
});
