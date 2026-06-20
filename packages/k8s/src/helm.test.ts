import { test, expect } from "vitest";
import { gzipSync, strToU8 } from "fflate";
import { decodeReleaseSecret, type HelmReleasePayload } from "./helm";

/** Encode a release object the way Helm v3 stores it in a Secret's data.release. */
function encodeRelease(payload: unknown): string {
  const json = JSON.stringify(payload);
  const gz = gzipSync(strToU8(json));
  let bin = "";
  for (const b of gz) bin += String.fromCharCode(b);
  const helmB64 = btoa(bin);        // base64(gzip(json)) — Helm's stored string
  return btoa(helmB64);             // base64 again — Kubernetes Secret data encoding
}

const SAMPLE: HelmReleasePayload = {
  name: "my-app",
  namespace: "apps",
  version: 2,
  info: {
    status: "deployed",
    first_deployed: "2026-06-01T00:00:00Z",
    last_deployed: "2026-06-10T00:00:00Z",
    description: "Upgrade complete",
    notes: "Thanks for installing my-app",
  },
  chart: { metadata: { name: "my-app", version: "1.2.3", appVersion: "4.5.6" }, values: { replicas: 1 } },
  config: { replicas: 3 },
  manifest: "apiVersion: v1\nkind: ConfigMap\n",
};

test("decodeReleaseSecret round-trips a gzipped release payload", () => {
  const encoded = encodeRelease(SAMPLE);
  const decoded = decodeReleaseSecret(encoded);
  expect(decoded).not.toBeNull();
  expect(decoded!.name).toBe("my-app");
  expect(decoded!.version).toBe(2);
  expect(decoded!.info.status).toBe("deployed");
  expect(decoded!.chart.metadata.version).toBe("1.2.3");
  expect(decoded!.config).toEqual({ replicas: 3 });
  expect(decoded!.manifest).toContain("kind: ConfigMap");
});

test("decodeReleaseSecret returns null on garbage", () => {
  expect(decodeReleaseSecret("not-base64-!@#")).toBeNull();
  expect(decodeReleaseSecret("")).toBeNull();
});

import { groupReleases, type ReleaseSecret } from "./helm";

function secret(name: string, namespace: string, payload: Partial<HelmReleasePayload>): ReleaseSecret {
  const full: HelmReleasePayload = {
    name: payload.name ?? "my-app",
    namespace,
    version: payload.version ?? 1,
    info: { status: payload.info?.status ?? "superseded", last_deployed: payload.info?.last_deployed },
    chart: payload.chart ?? { metadata: { name: "my-app", version: "1.0.0", appVersion: "1.0.0" } },
    config: payload.config ?? {},
    manifest: payload.manifest ?? "",
  };
  return { metadata: { name, namespace }, data: { release: encodeRelease(full) } };
}

test("groupReleases collapses revision secrets into one release with history", () => {
  const secrets: ReleaseSecret[] = [
    secret("sh.helm.release.v1.my-app.v1", "apps", { version: 1, info: { status: "superseded" } }),
    secret("sh.helm.release.v1.my-app.v2", "apps", { version: 2, info: { status: "deployed" } }),
    secret("sh.helm.release.v1.other.v1", "apps", { name: "other", version: 1, info: { status: "deployed" } }),
    secret("not-a-helm-secret", "apps", {}),
  ];
  const releases = groupReleases(secrets);
  expect(releases.map((r) => r.name).sort()).toEqual(["my-app", "other"]);
  const app = releases.find((r) => r.name === "my-app")!;
  expect(app.currentRevision).toBe(2);
  expect(app.status).toBe("deployed");
  expect(app.revisions.map((rv) => rv.revision)).toEqual([2, 1]); // newest first
});

test("groupReleases falls back to highest revision when none marked deployed", () => {
  const secrets: ReleaseSecret[] = [
    secret("sh.helm.release.v1.app.v1", "apps", { version: 1, info: { status: "failed" } }),
    secret("sh.helm.release.v1.app.v2", "apps", { version: 2, info: { status: "failed" } }),
  ];
  const app = groupReleases(secrets).find((r) => r.name === "app")!;
  expect(app.currentRevision).toBe(2);
});
