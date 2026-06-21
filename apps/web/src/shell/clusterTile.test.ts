import { test, expect } from "vitest";
import { tileInitials, classifyProvider, providerLabel } from "./clusterTile";

test("tileInitials takes the first two alphanumeric-run initials, uppercased", () => {
  expect(tileInitials("prod-eks")).toBe("PE");
  expect(tileInitials("home_k3s")).toBe("HK");
  expect(tileInitials("staging")).toBe("ST");
  expect(tileInitials("a")).toBe("A");
});

test("tileInitials falls back to '?' for an empty/odd name", () => {
  expect(tileInitials("")).toBe("?");
  expect(tileInitials("---")).toBe("?");
});

const ctx = (name: string, server = "", cluster = "") => ({ name, server, cluster });

test("classifyProvider detects cloud providers by server host or name", () => {
  expect(classifyProvider(ctx("prod", "https://ABC123.gr7.us-east-1.eks.amazonaws.com"))).toBe("aws");
  expect(classifyProvider(ctx("arn:aws:eks:us-east-1:123:cluster/prod"))).toBe("aws");
  expect(classifyProvider(ctx("gke_my-proj_us-central1_prod", "https://34.121.0.1"))).toBe("gcp");
  expect(classifyProvider(ctx("aks-prod", "https://prod-dns-abc.hcp.eastus.azmk8s.io:443"))).toBe("azure");
  expect(classifyProvider(ctx("do-nyc1-prod", "https://abc.k8s.ondigitalocean.com"))).toBe("digitalocean");
});

test("classifyProvider detects local clusters by name prefix or local/private server", () => {
  expect(classifyProvider(ctx("kind-dev", "https://127.0.0.1:52001"))).toBe("local");
  expect(classifyProvider(ctx("k3d-test", "https://0.0.0.0:6443"))).toBe("local");
  expect(classifyProvider(ctx("docker-desktop", "https://kubernetes.docker.internal:6443"))).toBe("local");
  expect(classifyProvider(ctx("minikube", "https://192.168.49.2:8443"))).toBe("local");
  expect(classifyProvider(ctx("home", "https://100.99.155.125:6443"))).toBe("local");
  expect(classifyProvider(ctx("lab", "https://10.0.0.5:6443"))).toBe("local");
});

test("classifyProvider falls back to generic for anything unrecognized", () => {
  expect(classifyProvider(ctx("mystery", "https://k8s.example.com:6443"))).toBe("generic");
  expect(classifyProvider(ctx(""))).toBe("generic");
});

test("providerLabel gives a human label", () => {
  expect(providerLabel("aws")).toBe("Amazon EKS");
  expect(providerLabel("gcp")).toBe("Google GKE");
  expect(providerLabel("local")).toBe("Local cluster");
  expect(providerLabel("generic")).toBe("Kubernetes cluster");
});
