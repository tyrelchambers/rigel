import { describe, expect, test } from "vitest";
import type { Node } from "@/panels/nodes/types";
import type { Pod } from "@/panels/pods/types";
import type { CatalogApp } from "@rigel/catalog";
import { nodeFit } from "./nodeFit";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(
  name: string,
  allocCPU: string,
  allocMem: string,
  overrides: Partial<Node> = {},
): Node {
  return {
    metadata: { name },
    spec: { unschedulable: false },
    status: {
      allocatable: { cpu: allocCPU, memory: allocMem },
      conditions: [{ type: "Ready", status: "True" }],
    },
    ...overrides,
  };
}

function makePod(
  nodeName: string,
  cpuRequest: string,
  memRequest: string,
  phase = "Running",
): Pod {
  return {
    metadata: { name: `pod-${Math.random()}`, uid: "uid", namespace: "default" },
    spec: {
      nodeName,
      containers: [
        {
          name: "app",
          resources: { requests: { cpu: cpuRequest, memory: memRequest } },
        },
      ],
    },
    status: { phase },
  };
}

function makeApp(
  cpuRequest: string,
  memoryRequest: string,
  storageGiB?: number,
): CatalogApp {
  return {
    id: "test-app",
    name: "Test App",
    tagline: "",
    description: "",
    category: "other",
    iconSystemName: "x",
    docsURL: "https://x",
    tags: [],
    matchImages: [],
    requirements: { cpuRequest, memoryRequest, storageGiB: storageGiB ?? null },
    persistence: false,
    exposesIngress: false,
    installPromptTemplate: "",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("nodeFit", () => {
  // 1. Ample capacity — eligible, canHost, recommended
  test("node with ample capacity is eligible and becomes recommended", () => {
    const node = makeNode("node-1", "4", "8Gi");
    const app = makeApp("500m", "512Mi");
    const result = nodeFit(app, [node], []);

    expect(result.perNode).toHaveLength(1);
    const entry = result.perNode[0];
    expect(entry.canHost).toBe(true);
    expect(entry.eligible).toBe(true);
    expect(result.recommended).toBe(entry);
    expect(result.anyFits).toBe(true);
  });

  // 2. Insufficient CPU — !canHost
  test("node whose free CPU is less than app request is not canHost", () => {
    const node = makeNode("node-1", "1", "8Gi"); // 1 core allocatable
    // Pod already consumes 900m, leaving 100m free
    const pod = makePod("node-1", "900m", "64Mi");
    const app = makeApp("500m", "64Mi"); // needs 500m but only 100m free
    const result = nodeFit(app, [node], [pod]);

    const entry = result.perNode[0];
    expect(entry.canHost).toBe(false);
    expect(entry.eligible).toBe(false);
    expect(result.recommended).toBeNull();
    expect(result.anyFits).toBe(false);
  });

  // 3. Insufficient memory — !canHost
  test("node whose free memory is less than app request is not canHost", () => {
    const node = makeNode("node-1", "4", "1Gi");
    const pod = makePod("node-1", "100m", "900Mi");
    const app = makeApp("100m", "512Mi"); // needs 512Mi but only ~124Mi free
    const result = nodeFit(app, [node], [pod]);

    const entry = result.perNode[0];
    expect(entry.canHost).toBe(false);
    expect(result.anyFits).toBe(false);
  });

  // 4. Cordoned node — ineligible (canHost may be true but eligible=false)
  test("cordoned node is ineligible", () => {
    const node = makeNode("node-1", "4", "8Gi", { spec: { unschedulable: true } });
    const app = makeApp("100m", "64Mi");
    const result = nodeFit(app, [node], []);

    const entry = result.perNode[0];
    expect(entry.cordoned).toBe(true);
    expect(entry.canHost).toBe(true); // resources fit
    expect(entry.eligible).toBe(false);
    expect(result.recommended).toBeNull();
  });

  // 5. NoSchedule-tainted node — ineligible
  test("NoSchedule-tainted node is ineligible", () => {
    const node = makeNode("node-1", "4", "8Gi", {
      spec: { unschedulable: false, taints: [{ key: "dedicated", effect: "NoSchedule" }] },
    });
    const app = makeApp("100m", "64Mi");
    const result = nodeFit(app, [node], []);

    const entry = result.perNode[0];
    expect(entry.tainted).toBe(true);
    expect(entry.eligible).toBe(false);
    expect(result.recommended).toBeNull();
  });

  // 6. NoExecute-tainted node — ineligible
  test("NoExecute-tainted node is ineligible", () => {
    const node = makeNode("node-1", "4", "8Gi", {
      spec: { unschedulable: false, taints: [{ key: "spot", effect: "NoExecute" }] },
    });
    const app = makeApp("100m", "64Mi");
    const result = nodeFit(app, [node], []);

    expect(result.perNode[0].tainted).toBe(true);
    expect(result.recommended).toBeNull();
  });

  // 7. PreferNoSchedule taint — NOT considered tainted (only NoSchedule/NoExecute)
  test("PreferNoSchedule-tainted node is NOT ineligible", () => {
    const node = makeNode("node-1", "4", "8Gi", {
      spec: { unschedulable: false, taints: [{ key: "spot", effect: "PreferNoSchedule" }] },
    });
    const app = makeApp("100m", "64Mi");
    const result = nodeFit(app, [node], []);

    expect(result.perNode[0].tainted).toBe(false);
    expect(result.recommended).not.toBeNull();
  });

  // 8. Not-ready node — !canHost
  test("not-ready node is not canHost", () => {
    const node = makeNode("node-1", "4", "8Gi", {
      status: {
        allocatable: { cpu: "4", memory: "8Gi" },
        conditions: [{ type: "Ready", status: "False" }],
      },
    });
    const app = makeApp("100m", "64Mi");
    const result = nodeFit(app, [node], []);

    const entry = result.perNode[0];
    expect(entry.canHost).toBe(false);
    expect(result.recommended).toBeNull();
  });

  // 9. Pod requests are subtracted; Succeeded/Failed pods are ignored
  test("Succeeded and Failed pod requests are NOT subtracted from free resources", () => {
    const node = makeNode("node-1", "2", "4Gi");
    // A 2-core request from a Succeeded pod should be ignored
    const succeededPod = makePod("node-1", "2", "4Gi", "Succeeded");
    // A 2-core request from a Failed pod should also be ignored
    const failedPod = makePod("node-1", "2", "4Gi", "Failed");
    const app = makeApp("1", "1Gi"); // needs 1 core, should still fit
    const result = nodeFit(app, [node], [succeededPod, failedPod]);

    const entry = result.perNode[0];
    // free CPU should remain ~2 (Succeeded+Failed not counted)
    expect(entry.freeCPU).toBeCloseTo(2, 5);
    expect(entry.canHost).toBe(true);
  });

  test("Running pod requests ARE subtracted from free resources", () => {
    const node = makeNode("node-1", "2", "4Gi");
    const runningPod = makePod("node-1", "1500m", "3Gi", "Running");
    const app = makeApp("1", "1Gi"); // needs 1 core; only 500m free
    const result = nodeFit(app, [node], [runningPod]);

    const entry = result.perNode[0];
    expect(entry.freeCPU).toBeCloseTo(0.5, 5);
    expect(entry.canHost).toBe(false);
  });

  test("Pending pod requests ARE subtracted from free resources", () => {
    const node = makeNode("node-1", "2", "4Gi");
    const pendingPod = makePod("node-1", "1500m", "3Gi", "Pending");
    const app = makeApp("600m", "512Mi");
    const result = nodeFit(app, [node], [pendingPod]);

    expect(result.perNode[0].canHost).toBe(false);
  });

  // 10. Sort order: eligible first by headroomScore desc, ineligible after by name asc
  test("eligible nodes sort before ineligible; eligible sorted by headroomScore desc", () => {
    // node-a: 4 cores, 8Gi — lots of headroom (eligible)
    const nodeA = makeNode("node-a", "4", "8Gi");
    // node-b: 2 cores, 4Gi — less headroom but still eligible
    const nodeB = makeNode("node-b", "2", "4Gi");
    // node-c: cordoned — ineligible
    const nodeC = makeNode("node-c", "8", "16Gi", { spec: { unschedulable: true } });
    // node-d: also ineligible (not enough CPU for the app)
    const nodeD = makeNode("node-d", "200m", "4Gi");

    const app = makeApp("500m", "256Mi"); // needs 500m; node-d only has 200m

    // Use pods to eat up some of node-b capacity so its headroom is lower than node-a
    const podB = makePod("node-b", "1", "2Gi");

    const result = nodeFit(app, [nodeA, nodeB, nodeC, nodeD], [podB]);
    const names = result.perNode.map((e) => e.node.metadata.name);

    // node-a should be first (highest headroom), node-b second (lower headroom),
    // then ineligible nodes alphabetically: node-c, node-d
    expect(names[0]).toBe("node-a");
    expect(names[1]).toBe("node-b");
    // ineligible nodes come last, sorted by name
    expect(names.slice(2).sort()).toEqual(["node-c", "node-d"]);
  });

  // 11. headroomScore — average of free/alloc ratios
  test("headroomScore is average of (freeCPU/allocCPU, freeMemory/allocMem)", () => {
    const node = makeNode("node-1", "4", "8Gi");
    const pod = makePod("node-1", "1", "2Gi"); // consumes 25% CPU, 25% mem
    const app = makeApp("100m", "64Mi");
    const result = nodeFit(app, [node], [pod]);
    const entry = result.perNode[0];

    // free CPU = 3/4 = 0.75, free mem = 6/8 = 0.75 → avg = 0.75
    expect(entry.headroomScore).toBeCloseTo(0.75, 5);
  });

  // 12. dot green: recommended.headroomScore >= 0.5
  test("dot is green when recommended headroomScore >= 0.5", () => {
    const node = makeNode("node-1", "4", "8Gi");
    const app = makeApp("100m", "64Mi");
    const result = nodeFit(app, [node], []);
    // headroomScore near 1.0 → green
    expect(result.dot).toBe("green");
  });

  // 13. dot yellow: recommended exists but headroomScore < 0.5
  test("dot is yellow when recommended headroomScore < 0.5", () => {
    // Give node 4 cores, 8Gi. Consume 3.5 cores and 6Gi (leaving <50% headroom)
    const node = makeNode("node-1", "4", "8Gi");
    const pod = makePod("node-1", "3500m", "6Gi");
    const app = makeApp("100m", "64Mi"); // small request, so it still fits
    const result = nodeFit(app, [node], [pod]);

    const entry = result.perNode[0];
    // freeCPU = 0.5/4 = 0.125, freeMem = 2Gi/8Gi = 0.25 → avg = 0.1875 < 0.5
    expect(entry.headroomScore).toBeLessThan(0.5);
    expect(result.dot).toBe("yellow");
  });

  // 14. dot red: no recommended
  test("dot is red when nothing fits", () => {
    const node = makeNode("node-1", "100m", "128Mi");
    const app = makeApp("2", "4Gi"); // way more than available
    const result = nodeFit(app, [node], []);

    expect(result.recommended).toBeNull();
    expect(result.dot).toBe("red");
  });

  // 15. recommended is null when nothing fits
  test("recommended is null when no node can fit the app", () => {
    const nodes = [
      makeNode("node-1", "100m", "128Mi"),
      makeNode("node-2", "200m", "256Mi"),
    ];
    const app = makeApp("2", "4Gi");
    const result = nodeFit(app, nodes, []);

    expect(result.recommended).toBeNull();
    expect(result.anyFits).toBe(false);
  });

  // 16. disk: freeDiskBytes = allocatableDiskBytes when no usedDiskBytes
  test("freeDiskBytes equals allocatableDiskBytes when disk usage is unknown", () => {
    const node = makeNode("node-1", "4", "8Gi", {
      status: {
        allocatable: { cpu: "4", memory: "8Gi", "ephemeral-storage": "100Gi" },
        conditions: [{ type: "Ready", status: "True" }],
      },
    });
    const app = makeApp("100m", "64Mi");
    const result = nodeFit(app, [node], []);

    const entry = result.perNode[0];
    expect(entry.allocatableDiskBytes).toBeGreaterThan(0);
    expect(entry.freeDiskBytes).toBe(entry.allocatableDiskBytes);
    expect(entry.usedDiskBytes).toBeUndefined();
  });

  // 17. disk fit: diskFits=true when allocDisk<=0 (no ephemeral-storage declared)
  test("disk fits when node has no ephemeral-storage declared", () => {
    const node = makeNode("node-1", "4", "8Gi"); // no ephemeral-storage in allocatable
    const app = makeApp("100m", "64Mi", 10); // asks for 10Gi
    const result = nodeFit(app, [node], []);

    // allocDisk=0 → diskFits=true (don't gate)
    expect(result.perNode[0].canHost).toBe(true);
  });

  // 18. disk fit: diskFits=true when app has no storageGiB (appDisk=0)
  test("disk fits when app requests no storage", () => {
    const node = makeNode("node-1", "4", "8Gi", {
      status: {
        allocatable: { cpu: "4", memory: "8Gi", "ephemeral-storage": "50Gi" },
        conditions: [{ type: "Ready", status: "True" }],
      },
    });
    const pod = makePod("node-1", "100m", "1Gi"); // consume most disk conceptually but disk not in pod resources
    const app = makeApp("100m", "64Mi"); // storageGiB absent → appDisk=0 → diskFits
    const result = nodeFit(app, [node], [pod]);

    expect(result.perNode[0].canHost).toBe(true);
  });

  // 19. pods without a nodeName are skipped
  test("pods without nodeName are not counted against any node", () => {
    const node = makeNode("node-1", "1", "2Gi");
    const floatingPod: Pod = {
      metadata: { name: "floating", uid: "uid2", namespace: "default" },
      spec: { containers: [{ name: "c", resources: { requests: { cpu: "900m", memory: "1.5Gi" } } }] },
      status: { phase: "Running" },
    };
    const app = makeApp("800m", "1Gi");
    const result = nodeFit(app, [node], [floatingPod]);

    // floating pod has no nodeName, so node-1 still has full capacity
    expect(result.perNode[0].freeCPU).toBeCloseTo(1, 5);
    expect(result.perNode[0].canHost).toBe(true);
  });
});
