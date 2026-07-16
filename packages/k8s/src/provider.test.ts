import { test, expect } from "vitest";
import { classifyProvider, isCloudProvider, CLOUD_PROVIDERS } from "./provider";

const ctx = (name: string, server = "") => ({ name, server });

test("classifyProvider tags cloud contexts", () => {
  expect(classifyProvider(ctx("gke_proj_us-central1_prod", "https://34.121.0.1"))).toBe("gcp");
  expect(classifyProvider(ctx("prod", "https://ABC.gr7.us-east-1.eks.amazonaws.com"))).toBe("aws");
  expect(classifyProvider(ctx("arn:aws:eks:us-east-1:1:cluster/prod"))).toBe("aws");
  expect(classifyProvider(ctx("aks-prod", "https://x.hcp.eastus.azmk8s.io:443"))).toBe("azure");
  expect(classifyProvider(ctx("do", "https://y.k8s.ondigitalocean.com"))).toBe("digitalocean");
});

test("classifyProvider tags local/generic contexts", () => {
  expect(classifyProvider(ctx("kind-dev", "https://127.0.0.1:52001"))).toBe("local");
  expect(classifyProvider(ctx("k3d-test", "https://0.0.0.0:6443"))).toBe("local");
  expect(classifyProvider(ctx("home", "https://100.99.155.125:6443"))).toBe("local");
  expect(classifyProvider(ctx("mystery", "https://k8s.example.com:6443"))).toBe("generic");
});

test("isCloudProvider is true only for the four cloud kinds", () => {
  expect(isCloudProvider("gcp")).toBe(true);
  expect(isCloudProvider("aws")).toBe(true);
  expect(isCloudProvider("azure")).toBe(true);
  expect(isCloudProvider("digitalocean")).toBe(true);
  expect(isCloudProvider("local")).toBe(false);
  expect(isCloudProvider("generic")).toBe(false);
  for (const p of CLOUD_PROVIDERS) expect(isCloudProvider(p)).toBe(true);
});
