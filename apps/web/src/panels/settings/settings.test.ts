import { describe, it, expect, beforeEach } from "vitest";
import {
  selfHostKey,
  loadSelfHostDefaults,
  saveSelfHostDefaults,
  EMPTY_SELF_HOST_DEFAULTS,
} from "./useSettings";
import { signalBridgeManifest, deriveSignalBridgeStatus, parseRecipients } from "@helmsman/k8s";

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

describe("self-host defaults (localStorage)", () => {
  it("keys by kubectl context", () => {
    expect(selfHostKey("prod-cluster")).toBe("helmsman_selfhost_defaults_prod-cluster");
  });

  it("round-trips and trims whitespace", () => {
    saveSelfHostDefaults("ctx", {
      ...EMPTY_SELF_HOST_DEFAULTS,
      ingressDomain: "  apps.example.com  ",
      edgeIP: " 1.2.3.4 ",
    });
    const back = loadSelfHostDefaults("ctx");
    expect(back.ingressDomain).toBe("apps.example.com");
    expect(back.edgeIP).toBe("1.2.3.4");
  });

  it("isolates contexts", () => {
    saveSelfHostDefaults("a", { ...EMPTY_SELF_HOST_DEFAULTS, ingressDomain: "a.example.com" });
    saveSelfHostDefaults("b", { ...EMPTY_SELF_HOST_DEFAULTS, ingressDomain: "b.example.com" });
    expect(loadSelfHostDefaults("a").ingressDomain).toBe("a.example.com");
    expect(loadSelfHostDefaults("b").ingressDomain).toBe("b.example.com");
  });

  it("falls back to empty when unset or corrupt", () => {
    expect(loadSelfHostDefaults("missing")).toEqual(EMPTY_SELF_HOST_DEFAULTS);
    localStorage.setItem(selfHostKey("bad"), "{not json");
    expect(loadSelfHostDefaults("bad")).toEqual(EMPTY_SELF_HOST_DEFAULTS);
  });
});

describe("shared signal logic reachable via the web alias", () => {
  it("substitutes the namespace into the manifest", () => {
    expect(signalBridgeManifest("staging")).toContain("namespace: staging");
  });

  it("derives the 5 bridge states", () => {
    const dep = (ready: number) => ({
      metadata: { name: "signal-cli-rest", namespace: "default" },
      status: { readyReplicas: ready },
    });
    expect(deriveSignalBridgeStatus([], "default", false, false)).toBe("notDeployed");
    expect(deriveSignalBridgeStatus([dep(1)], "default", false, true)).toBe("deploying");
    expect(deriveSignalBridgeStatus([dep(0)], "default", false, false)).toBe("starting");
    expect(deriveSignalBridgeStatus([dep(1)], "default", false, false)).toBe("ready");
    expect(deriveSignalBridgeStatus([dep(1)], "default", true, false)).toBe("linked");
  });

  it("parses comma-separated recipients", () => {
    expect(parseRecipients(" +1555, +1666 ,")).toEqual(["+1555", "+1666"]);
  });
});
