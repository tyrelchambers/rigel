import { test, expect } from "vitest";
import { resolveIconId } from "./clusterIconStore";
import { providerDefaultIcon, CLUSTER_ICONS, ICON_PALETTE } from "./clusterIcons";
import type { ProviderKind } from "./clusterTile";

test("resolveIconId prefers the override, else the provider default", () => {
  expect(resolveIconId("prod", "aws", {})).toBe("aws");
  expect(resolveIconId("prod", "aws", { prod: "monitor" })).toBe("monitor");
  expect(resolveIconId("dev", "local", {})).toBe("monitor");
});

test("every provider's default icon id exists in the registry", () => {
  const kinds: ProviderKind[] = ["local", "aws", "gcp", "azure", "digitalocean", "generic"];
  for (const k of kinds) expect(CLUSTER_ICONS[providerDefaultIcon(k)]).toBeTruthy();
});

test("every palette id exists in the registry", () => {
  for (const id of ICON_PALETTE) expect(CLUSTER_ICONS[id]).toBeTruthy();
});
