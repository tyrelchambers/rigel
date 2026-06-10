import { test, expect } from "bun:test";
import {
  signalBridgeManifest,
  deriveSignalBridgeStatus,
  signalStatusColor,
  signalStatusLabel,
  parseRecipients,
  signalApiUrl,
  hasSavedNumber,
  signalInbound,
  signalConfigUpdates,
} from "./signal";

// --- Manifest substitution -------------------------------------------------

test("manifest substitutes <NAMESPACE> into all three docs", () => {
  const yaml = signalBridgeManifest("prod");
  // PVC, Deployment, Service each carry the namespace.
  expect((yaml.match(/namespace: prod/g) ?? []).length).toBe(3);
  expect(yaml).toContain("kind: PersistentVolumeClaim");
  expect(yaml).toContain("kind: Deployment");
  expect(yaml).toContain("kind: Service");
  expect(yaml).toContain("bbernhard/signal-cli-rest-api:latest");
});

test("manifest defaults an empty namespace to default", () => {
  expect(signalBridgeManifest("  ")).toContain("namespace: default");
});

// --- Status derivation (all 5 states) --------------------------------------

const dep = (namespace: string, ready: number) => ({
  metadata: { name: "signal-cli-rest", namespace },
  status: { readyReplicas: ready },
});

test("applying flag wins → deploying", () => {
  expect(deriveSignalBridgeStatus([dep("default", 1)], "default", true, true)).toBe("deploying");
});

test("no deployment → notDeployed", () => {
  expect(deriveSignalBridgeStatus([], "default", false, false)).toBe("notDeployed");
});

test("deployment in a different namespace → notDeployed", () => {
  expect(deriveSignalBridgeStatus([dep("other", 1)], "default", false, false)).toBe("notDeployed");
});

test("readyReplicas < 1 → starting", () => {
  expect(deriveSignalBridgeStatus([dep("default", 0)], "default", false, false)).toBe("starting");
});

test("ready replica, no saved number → ready", () => {
  expect(deriveSignalBridgeStatus([dep("default", 1)], "default", false, false)).toBe("ready");
});

test("ready replica, saved number → linked", () => {
  expect(deriveSignalBridgeStatus([dep("default", 1)], "default", true, false)).toBe("linked");
});

// --- Color + label ---------------------------------------------------------

test("status colors are dot-mapped", () => {
  expect(signalStatusColor("notDeployed")).toBe("gray");
  expect(signalStatusColor("deploying")).toBe("amber");
  expect(signalStatusColor("starting")).toBe("amber");
  expect(signalStatusColor("ready")).toBe("blue");
  expect(signalStatusColor("linked")).toBe("green");
});

test("status labels are human-readable", () => {
  expect(signalStatusLabel("ready")).toMatch(/link a phone/);
  expect(signalStatusLabel("linked")).toBe("Linked");
});

// --- Recipients parsing ----------------------------------------------------

test("recipients parse trims and drops empties", () => {
  expect(parseRecipients("+1555, ,+1666 ,")).toEqual(["+1555", "+1666"]);
  expect(parseRecipients("")).toEqual([]);
  expect(parseRecipients("   ")).toEqual([]);
});

// --- assistant-config helpers ----------------------------------------------

test("signalApiUrl builds the in-cluster URL", () => {
  expect(signalApiUrl("ns1")).toBe("http://signal-cli-rest.ns1.svc.cluster.local:8080");
});

test("hasSavedNumber + signalInbound read config data", () => {
  expect(hasSavedNumber({ signalNumber: "+1555" })).toBe(true);
  expect(hasSavedNumber({ signalNumber: "  " })).toBe(false);
  expect(hasSavedNumber({})).toBe(false);
  expect(signalInbound({ signalInbound: "true" })).toBe(true);
  expect(signalInbound({ signalInbound: "false" })).toBe(false);
  expect(signalInbound({})).toBe(false);
});

test("signalConfigUpdates includes only provided fields", () => {
  expect(signalConfigUpdates({ number: "+1555", inbound: true })).toEqual({
    signalNumber: "+1555",
    signalInbound: "true",
  });
  expect(signalConfigUpdates({ recipients: "" })).toEqual({ signalRecipients: "" });
  expect(signalConfigUpdates({})).toEqual({});
});
