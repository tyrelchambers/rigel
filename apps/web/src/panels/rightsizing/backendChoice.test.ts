import { describe, test, expect, beforeEach } from "vitest";
import {
  metricsBackendKey,
  loadBackendChoice,
  saveBackendChoice,
  choiceSelectValue,
  backendValue,
} from "./backendChoice";

// Minimal in-memory localStorage stub (vitest runs in node by default).
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

test("metricsBackendKey is keyed by context", () => {
  expect(metricsBackendKey("prod")).toBe("helmsman_metrics_backend_prod");
});

describe("load/save round-trip", () => {
  test("defaults to auto when unset or garbage", () => {
    expect(loadBackendChoice("c")).toEqual({ kind: "auto" });
    localStorage.setItem(metricsBackendKey("c"), "{bad json");
    expect(loadBackendChoice("c")).toEqual({ kind: "auto" });
  });

  test("persists a prometheus choice per context", () => {
    const prom = { kind: "prometheus", namespace: "mon", service: "vm", port: 8428, flavor: "VictoriaMetrics" } as const;
    saveBackendChoice("c", prom);
    expect(loadBackendChoice("c")).toEqual(prom);
    // isolation across contexts
    expect(loadBackendChoice("other")).toEqual({ kind: "auto" });
  });

  test("maps a legacy 'local' choice and malformed entries to auto", () => {
    localStorage.setItem(metricsBackendKey("c"), JSON.stringify({ kind: "local" }));
    expect(loadBackendChoice("c")).toEqual({ kind: "auto" });
    localStorage.setItem(metricsBackendKey("c"), JSON.stringify({ kind: "prometheus", service: "x" }));
    expect(loadBackendChoice("c")).toEqual({ kind: "auto" });
  });
});

describe("choiceSelectValue", () => {
  const auto = { namespace: "helmsman-metrics", service: "helmsman-metrics", port: 8428, flavor: "VictoriaMetrics" };
  test("prometheus → its encoded value", () => {
    expect(choiceSelectValue({ kind: "prometheus", ...auto }, null)).toBe(backendValue(auto));
  });
  test("auto → the resolved backend, or empty when none", () => {
    expect(choiceSelectValue({ kind: "auto" }, auto)).toBe(backendValue(auto));
    expect(choiceSelectValue({ kind: "auto" }, null)).toBe("");
  });
});
