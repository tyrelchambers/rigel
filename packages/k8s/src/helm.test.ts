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
