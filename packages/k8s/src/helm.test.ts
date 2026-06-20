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

import {
  buildHelmInstallCommands,
  buildHelmRollbackArgs,
  buildHelmUninstallArgs,
  type HelmChartSource,
} from "./helm";

const opts = { releaseName: "web", namespace: "apps", valuesFile: "/tmp/v.yaml", context: "kind-test" };

// The release name and chart ref always come last, after a `--` terminator, so
// helm/pflag can never parse them as flags (the option-injection fix).
test("install commands: repo source does add -> update -> upgrade --install", () => {
  const src: HelmChartSource = { kind: "repo", repoName: "jetstack", repoURL: "https://charts.jetstack.io", chart: "cert-manager", version: "v1.14.0" };
  const cmds = buildHelmInstallCommands(src, opts);
  expect(cmds[0]).toEqual(["repo", "add", "--", "jetstack", "https://charts.jetstack.io"]);
  expect(cmds[1]).toEqual(["repo", "update", "--", "jetstack"]);
  expect(cmds[2]).toEqual([
    "upgrade", "--install", "--version", "v1.14.0",
    "-n", "apps", "--create-namespace", "-f", "/tmp/v.yaml", "--kube-context", "kind-test",
    "--", "web", "jetstack/cert-manager",
  ]);
});

test("install commands: oci source skips repo add and installs the ref directly", () => {
  const src: HelmChartSource = { kind: "oci", ref: "oci://registry-1.docker.io/bitnamicharts/postgresql", version: "16.0.0" };
  const cmds = buildHelmInstallCommands(src, opts);
  expect(cmds).toHaveLength(1);
  expect(cmds[0]).toEqual([
    "upgrade", "--install", "--version", "16.0.0",
    "-n", "apps", "--create-namespace", "-f", "/tmp/v.yaml", "--kube-context", "kind-test",
    "--", "web", "oci://registry-1.docker.io/bitnamicharts/postgresql",
  ]);
});

test("install commands: local source installs from a path, no version flag", () => {
  const cmds = buildHelmInstallCommands({ kind: "local", path: "/charts/web-1.0.0.tgz" }, opts);
  expect(cmds).toHaveLength(1);
  expect(cmds[0]).toEqual([
    "upgrade", "--install",
    "-n", "apps", "--create-namespace", "-f", "/tmp/v.yaml", "--kube-context", "kind-test",
    "--", "web", "/charts/web-1.0.0.tgz",
  ]);
});

test("install commands: omit context flag when context is null", () => {
  const cmds = buildHelmInstallCommands({ kind: "local", path: "/c.tgz" }, { ...opts, context: null });
  expect(cmds[0]).not.toContain("--kube-context");
});

test("rollback args include revision, namespace, context", () => {
  expect(buildHelmRollbackArgs("web", 3, "apps", "kind-test")).toEqual([
    "rollback", "-n", "apps", "--kube-context", "kind-test", "--", "web", "3",
  ]);
});

test("uninstall args include namespace + context", () => {
  expect(buildHelmUninstallArgs("web", "apps", null)).toEqual(["uninstall", "-n", "apps", "--", "web"]);
  expect(buildHelmUninstallArgs("web", "apps", "kind-test")).toEqual([
    "uninstall", "-n", "apps", "--kube-context", "kind-test", "--", "web",
  ]);
});

import { validateHelmInstall, validateHelmTarget, isSafeHelmArg, isHttpRepoURL } from "./helm";

test("validateHelmInstall accepts well-formed repo/oci/local sources", () => {
  expect(validateHelmInstall(
    { kind: "repo", repoName: "jetstack", repoURL: "https://charts.jetstack.io", chart: "cert-manager", version: "v1.14.0" },
    "web", "apps",
  )).toBeNull();
  expect(validateHelmInstall({ kind: "oci", ref: "oci://registry-1.docker.io/bitnamicharts/postgresql", version: "16.0.0" }, "web", "apps")).toBeNull();
  expect(validateHelmInstall({ kind: "local", path: "/charts/web-1.0.0.tgz" }, "web", "apps")).toBeNull();
});

test("validateHelmInstall rejects option-injection in every user field", () => {
  const ns = "apps", name = "web";
  // release name / namespace must be DNS-1123 (forbids a leading dash)
  expect(validateHelmInstall({ kind: "local", path: "/c.tgz" }, "--post-renderer=/tmp/x", ns)).not.toBeNull();
  expect(validateHelmInstall({ kind: "local", path: "/c.tgz" }, name, "--kubeconfig=/tmp/x")).not.toBeNull();
  // chart path can't start with '-'
  expect(validateHelmInstall({ kind: "local", path: "--post-renderer=/tmp/pwn.sh" }, name, ns)).not.toBeNull();
  // oci ref must be a real oci:// ref
  expect(validateHelmInstall({ kind: "oci", ref: "--kubeconfig=/tmp/evil.yaml" }, name, ns)).not.toBeNull();
  // version flag value can't start with '-'
  expect(validateHelmInstall({ kind: "oci", ref: "oci://r/c", version: "--post-renderer=/tmp/x" }, name, ns)).not.toBeNull();
  // repo URL must be http(s); repo/chart names can't start with '-'
  expect(validateHelmInstall({ kind: "repo", repoName: "x", repoURL: "file:///etc/passwd", chart: "c" }, name, ns)).not.toBeNull();
  expect(validateHelmInstall({ kind: "repo", repoName: "x", repoURL: "--repo", chart: "c" }, name, ns)).not.toBeNull();
  expect(validateHelmInstall({ kind: "repo", repoName: "-x", repoURL: "https://e.io", chart: "c" }, name, ns)).not.toBeNull();
  expect(validateHelmInstall({ kind: "repo", repoName: "x", repoURL: "https://e.io", chart: "--chart" }, name, ns)).not.toBeNull();
});

test("validateHelmTarget enforces DNS-1123 names (rollback/uninstall)", () => {
  expect(validateHelmTarget("web", "apps")).toBeNull();
  expect(validateHelmTarget("--post-renderer=/tmp/x", "apps")).not.toBeNull();
  expect(validateHelmTarget("web", "--kubeconfig=/tmp/x")).not.toBeNull();
});

test("isSafeHelmArg / isHttpRepoURL guards", () => {
  expect(isSafeHelmArg("cert-manager")).toBe(true);
  expect(isSafeHelmArg("oci://r/c")).toBe(true);
  expect(isSafeHelmArg("--post-renderer=/tmp/x")).toBe(false);
  expect(isSafeHelmArg("")).toBe(false);
  expect(isHttpRepoURL("https://charts.jetstack.io")).toBe(true);
  expect(isHttpRepoURL("http://charts.local")).toBe(true);
  expect(isHttpRepoURL("file:///etc/passwd")).toBe(false);
  expect(isHttpRepoURL("--repo")).toBe(false);
});
