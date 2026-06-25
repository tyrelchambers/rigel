import { test, expect } from "vitest";
import { descriptorFor, listCloudProviders } from "./descriptors";

test("descriptorFor returns the DigitalOcean descriptor", () => {
  const d = descriptorFor("digitalocean");
  expect(d?.binary).toBe("doctl");
  expect(d?.requiredParams).toEqual([]);
  expect(d?.consoleUrl).toBe("https://cloud.digitalocean.com/kubernetes/clusters");
});

test("descriptorFor returns undefined for unknown/non-cloud providers", () => {
  expect(descriptorFor("local")).toBeUndefined();
  expect(descriptorFor("aws")).toBeUndefined(); // fast-follow, not built yet
});

test("DigitalOcean builds the expected list and connect argv", () => {
  const d = descriptorFor("digitalocean")!;
  expect(d.listClustersArgs({})).toEqual(["kubernetes", "cluster", "list", "-o", "json"]);
  expect(d.connectArgs({ id: "abc-123", name: "prod", region: "nyc1" }, {})).toEqual([
    "kubernetes", "cluster", "kubeconfig", "save", "abc-123",
  ]);
  expect(d.authCheckArgs).toEqual(["account", "get", "-o", "json"]);
});

test("DigitalOcean parseAccount extracts the email from auth-check JSON", () => {
  const d = descriptorFor("digitalocean")!;
  expect(d.parseAccount?.(JSON.stringify({ email: "me@example.com", uuid: "x" }))).toBe("me@example.com");
  expect(d.parseAccount?.(JSON.stringify({}))).toBeNull();
  expect(d.parseAccount?.(JSON.stringify({ uuid: "x" }))).toBeNull();
  // Array form (defensive guard)
  expect(d.parseAccount?.(JSON.stringify([{ email: "arr@example.com" }]))).toBe("arr@example.com");
});

test("DigitalOcean parses doctl JSON cluster output", () => {
  const d = descriptorFor("digitalocean")!;
  const stdout = JSON.stringify([
    { id: "abc-123", name: "prod", region: "nyc1", version: "1.30" },
    { id: "def-456", name: "stage", region: "sfo3", version: "1.30" },
  ]);
  expect(d.parseClusterList(stdout)).toEqual([
    { id: "abc-123", name: "prod", region: "nyc1" },
    { id: "def-456", name: "stage", region: "sfo3" },
  ]);
});

test("listCloudProviders returns exactly the built providers", () => {
  expect(listCloudProviders().map((d) => d.id)).toEqual(["digitalocean"]);
});
