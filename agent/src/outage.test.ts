import { describe, expect, test } from "vitest";
import { outageAround, outageOf } from "./outage.js";
import type { Incident } from "./detector.js";

const dep = (name: string, desired: number, ready: number) => ({ metadata: { name, namespace: "default" }, spec: { replicas: desired }, status: { readyReplicas: ready } });
const apiPod = { metadata: { name: "api-7f9-x", namespace: "default", labels: { "pod-template-hash": "7f9" }, ownerReferences: [{ kind: "ReplicaSet", name: "api-7f9" }] } };
const logErr: Incident = { incidentKind: "loggedError", namespace: "default", name: "api-7f9-x", reason: "fatal", detail: "" };
const dbDown: Incident = { incidentKind: "databaseNotReady", namespace: "default", name: "postgres", reason: "NoPrimary", detail: "" };

describe("outageOf", () => {
  test("a database with no primary and a fully-down deployment are outages", () => {
    expect(outageOf(dbDown, [])).toBe("the postgres database is down");
    expect(outageOf({ incidentKind: "degradedDeployment", namespace: "default", name: "api", reason: "Degraded", detail: "" }, [dep("api", 3, 0)])).toBe("api is completely down");
  });

  test("partial degradation is not", () => {
    expect(outageOf({ incidentKind: "degradedDeployment", namespace: "default", name: "api", reason: "Degraded", detail: "" }, [dep("api", 3, 2)])).toBeNull();
    expect(outageOf({ ...dbDown, reason: "Degraded" }, [])).toBeNull();
  });
});

describe("outageAround", () => {
  test("a logged error during a database outage is part of it", () => {
    expect(outageAround(logErr, [logErr, dbDown], [apiPod], [dep("api", 3, 3)])).toBe("the postgres database is down");
  });

  test("a logged error from a fully-down deployment is part of it", () => {
    expect(outageAround(logErr, [logErr], [apiPod], [dep("api", 3, 0)])).toBe("api is completely down");
  });

  test("a logged error from a healthy workload is not", () => {
    expect(outageAround(logErr, [logErr], [apiPod], [dep("api", 3, 3)])).toBeNull();
  });
});
