import { describe, expect, test } from "vitest";
import {
  RECENT_WINDOW_MS,
  ledgerDiscoveryArgs,
  parseLedgerBatches,
  expiredLedgers,
  type LedgerItem,
} from "./recentDeploys";

const now = Date.parse("2026-07-07T12:00:00.000Z");
const recent = "2026-07-07T10:00:00.000Z";
const old = "2026-06-01T10:00:00.000Z"; // > 14 days ago

function cm(namespace: string, batch: object) {
  return { metadata: { namespace }, data: { "batch.json": JSON.stringify(batch) } };
}

describe("ledgerDiscoveryArgs", () => {
  test("selects ledger ConfigMaps by label across all namespaces as json", () => {
    expect(ledgerDiscoveryArgs()).toEqual([
      "get", "configmap", "--all-namespaces", "-l", "rigel.dev/ledger=apply-batch", "-o", "json",
    ]);
  });
});

describe("parseLedgerBatches", () => {
  test("parses in-window ledgers, newest first, carrying the ledger's own namespace", () => {
    const items = [
      cm("shop", { batchId: "b1", appliedAt: recent, source: "compose-migration", resources: [{ kind: "Deployment", name: "web", namespace: "shop" }] }),
      cm("default", { batchId: "b2", appliedAt: "2026-07-07T11:00:00.000Z", source: "apply-yaml", resources: [{ kind: "Service", name: "api", namespace: "billing" }] }),
    ];
    expect(parseLedgerBatches(items, now, RECENT_WINDOW_MS)).toEqual([
      { batchId: "b2", source: "apply-yaml", appliedAt: "2026-07-07T11:00:00.000Z", ledgerNamespace: "default", resources: [{ kind: "Service", name: "api", namespace: "billing" }] },
      { batchId: "b1", source: "compose-migration", appliedAt: recent, ledgerNamespace: "shop", resources: [{ kind: "Deployment", name: "web", namespace: "shop" }] },
    ]);
  });

  test("drops out-of-window ledgers and unparseable payloads", () => {
    const items = [
      cm("shop", { batchId: "b0", appliedAt: old, source: "apply-yaml", resources: [] }),
      { metadata: { namespace: "shop" }, data: { "batch.json": "not json" } },
      { metadata: { namespace: "shop" }, data: {} },
    ];
    expect(parseLedgerBatches(items, now, RECENT_WINDOW_MS)).toEqual([]);
  });
});

describe("expiredLedgers", () => {
  function named(name: string, namespace: string, batch: object) {
    return { metadata: { name, namespace }, data: { "batch.json": JSON.stringify(batch) } };
  }

  test("returns name+namespace for ledgers older than the window only", () => {
    const items = [
      named("rigel-apply-a", "shop", { batchId: "a", appliedAt: old, source: "apply-yaml", resources: [] }),
      named("rigel-apply-b", "default", { batchId: "b", appliedAt: recent, source: "apply-yaml", resources: [] }),
    ];
    expect(expiredLedgers(items, now, RECENT_WINDOW_MS)).toEqual([
      { name: "rigel-apply-a", namespace: "shop" },
    ]);
  });

  test("skips items without a name or a parseable appliedAt", () => {
    const items: LedgerItem[] = [
      { metadata: { namespace: "shop" }, data: { "batch.json": JSON.stringify({ appliedAt: old }) } },
      named("rigel-apply-x", "shop", { batchId: "x", appliedAt: "garbage", source: "apply-yaml", resources: [] }),
      { metadata: { name: "rigel-apply-y", namespace: "shop" }, data: {} },
    ];
    expect(expiredLedgers(items, now, RECENT_WINDOW_MS)).toEqual([]);
  });
});
