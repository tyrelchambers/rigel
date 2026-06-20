import { test, expect } from "vitest";
import { gzipSync, strToU8 } from "fflate";
import { releasesFromSecretsMap, releaseStatusTone, formatTimestamp } from "./releases";

function encode(payload: unknown): string {
  let bin = "";
  for (const b of gzipSync(strToU8(JSON.stringify(payload)))) bin += String.fromCharCode(b);
  return btoa(btoa(bin));
}
function sec(name: string, namespace: string, version: number, status: string) {
  return {
    metadata: { name, namespace },
    data: { release: encode({ name: name.replace(/^sh\.helm\.release\.v1\.|\.v\d+$/g, ""), namespace, version, info: { status }, chart: { metadata: { name: "c", version: "1.0.0" } } }) },
  };
}

test("releasesFromSecretsMap derives releases from a store secrets map, ignoring non-helm secrets", () => {
  const map = {
    "apps/sh.helm.release.v1.web.v1": sec("sh.helm.release.v1.web.v1", "apps", 1, "superseded"),
    "apps/sh.helm.release.v1.web.v2": sec("sh.helm.release.v1.web.v2", "apps", 2, "deployed"),
    "apps/regular-secret": { metadata: { name: "regular-secret", namespace: "apps" }, data: { foo: btoa("bar") } },
  };
  const releases = releasesFromSecretsMap(map);
  expect(releases).toHaveLength(1);
  expect(releases[0].name).toBe("web");
  expect(releases[0].currentRevision).toBe(2);
});

test("releaseStatusTone maps helm statuses to a color tone", () => {
  expect(releaseStatusTone("deployed")).toBe("green");
  expect(releaseStatusTone("failed")).toBe("red");
  expect(releaseStatusTone("pending-install")).toBe("yellow");
  expect(releaseStatusTone("pending-upgrade")).toBe("yellow");
  expect(releaseStatusTone("pending-rollback")).toBe("yellow");
  expect(releaseStatusTone("uninstalling")).toBe("yellow");
  expect(releaseStatusTone("superseded")).toBe("neutral");
  expect(releaseStatusTone("uninstalled")).toBe("neutral");
  expect(releaseStatusTone("whatever")).toBe("neutral");
});

test("formatTimestamp renders a readable date and tolerates bad input", () => {
  expect(formatTimestamp(null)).toBe("—");
  expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  expect(formatTimestamp("2026-05-29T09:08:59.703925-04:00")).toContain("2026");
});
