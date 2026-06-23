import { test, expect } from "vitest";
import { validateInstall } from "./assistant";

// Install validation (mirrors Swift AssistantViewModel.install() guards). The
// happy path and each rejection are deterministic and run without a cluster.

test("validateInstall accepts a lowercase namespace + image + token", () => {
  expect(() =>
    validateInstall("default", "sk-token", "ghcr.io/acme/rigel-assistant:latest"),
  ).not.toThrow();
});

test("validateInstall rejects an empty token", () => {
  expect(() => validateInstall("default", "   ", "ghcr.io/acme/x:latest")).toThrow(/setup-token/);
});

test("validateInstall rejects an empty image", () => {
  expect(() => validateInstall("default", "sk", "  ")).toThrow(/container image/);
});

test("validateInstall rejects an uppercase image repository", () => {
  expect(() => validateInstall("default", "sk", "ghcr.io/Acme/x:latest")).toThrow(/lowercase/);
});

test("validateInstall ignores the tag when checking image case", () => {
  // Uppercase only in the TAG is allowed (k8s only rejects uppercase repos).
  expect(() => validateInstall("default", "sk", "ghcr.io/acme/x:LATEST")).not.toThrow();
});

test("validateInstall rejects an empty namespace", () => {
  expect(() => validateInstall("  ", "sk", "ghcr.io/acme/x:latest")).toThrow(/install namespace/);
});

test("validateInstall rejects an uppercase namespace", () => {
  expect(() => validateInstall("Default", "sk", "ghcr.io/acme/x:latest")).toThrow(/lowercase/);
});

import { parseCredentials, type AssistantRequest } from "./assistant";

test("parseCredentials picks up every provided credential, trimming empties", () => {
  const req: AssistantRequest = {
    action: "setCredentials",
    credentials: {
      geminiApiKey: "g-1",
      codexApiKey: "   ",
      opencodeAuthContent: "blob",
      anthropicApiKey: "",
    },
  };
  expect(parseCredentials(req)).toEqual({ geminiApiKey: "g-1", opencodeAuthContent: "blob" });
});

test("parseCredentials maps a legacy top-level token onto claudeToken", () => {
  const req: AssistantRequest = { action: "setCredentials", token: "tok-legacy" };
  expect(parseCredentials(req)).toEqual({ claudeToken: "tok-legacy" });
});

test("parseCredentials returns an empty object when nothing is provided", () => {
  expect(parseCredentials({ action: "setCredentials" })).toEqual({});
});
