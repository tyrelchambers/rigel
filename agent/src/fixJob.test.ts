import { describe, expect, test } from "vitest";
import {
  buildFixJob,
  buildFixSpecConfigMap,
  fixJobId,
  fixResourceName,
  readFixMeta,
  FIX_SPEC_KEY,
  FIX_LABEL,
  FIX_ANNOTATION,
  type FixMeta,
  type FixSpec,
} from "./fixJob.js";

const SPEC: FixSpec = {
  source: { name: "memos", repoURL: "https://github.com/me/infra", branch: "main", path: "apps/memos" },
  filePath: "apps/memos/deployment.yaml",
  content: "kind: Deployment\n...",
  title: "Bump memos image to a healthy tag",
  body: "The pinned tag CrashLoops.",
};

const FP = "unhealthyPod|default|memos-7d9f-abc|CrashLoopBackOff";

const META: FixMeta = {
  fingerprint: FP,
  filePath: SPEC.filePath,
  incident: "default/memos-7d9f-abc: CrashLoopBackOff",
  repoURL: "https://github.com/me/infra",
  branch: "main",
  source: "memos",
  title: "Bump memos image to a healthy tag",
};

describe("fixJobId", () => {
  test("is deterministic for the same fingerprint + filePath", () => {
    expect(fixJobId(FP, SPEC.filePath)).toBe(fixJobId(FP, SPEC.filePath));
  });

  test("differs when the fingerprint or filePath differs (collision-safe)", () => {
    expect(fixJobId(FP, "a.yaml")).not.toBe(fixJobId(FP, "b.yaml"));
    expect(fixJobId("otherfp", SPEC.filePath)).not.toBe(fixJobId(FP, SPEC.filePath));
  });

  test("yields a DNS-1123 label and keeps rigel-fix-<id> within 63 chars", () => {
    const long = "loggedError|" + "x".repeat(300) + "|CrashLoopBackOff";
    const id = fixJobId(long, "very/deeply/nested/" + "p".repeat(200) + ".yaml");
    expect(fixResourceName(id).length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  });

  test("falls back to the bare hash when the fingerprint sanitizes to empty", () => {
    const id = fixJobId("|||", "f.yaml");
    expect(id).toMatch(/^[a-f0-9]{10}$/);
  });
});

describe("buildFixSpecConfigMap", () => {
  test("serializes the spec under spec.json with the rigel-fix-<id> name", () => {
    const id = fixJobId(FP, SPEC.filePath);
    const cm = buildFixSpecConfigMap("default", id, SPEC, META);
    expect(cm.kind).toBe("ConfigMap");
    expect(cm.metadata.name).toBe(fixResourceName(id));
    expect(cm.metadata.namespace).toBe("default");
    expect(cm.metadata.labels["rigel.dev/fix-id"]).toBe(id);
    expect(cm.metadata.labels[FIX_LABEL]).toBe("true");
    expect(JSON.parse(cm.data[FIX_SPEC_KEY]!)).toEqual(SPEC);
  });

  test("stamps the fix provenance as annotations the reconcile reads back", () => {
    const id = fixJobId(FP, SPEC.filePath);
    const cm = buildFixSpecConfigMap("default", id, SPEC, META);
    expect(cm.metadata.annotations[FIX_ANNOTATION.fingerprint]).toBe(FP);
    expect(readFixMeta(cm.metadata.annotations)).toEqual(META);
  });
});

describe("buildFixJob", () => {
  const id = fixJobId(FP, SPEC.filePath);
  const job = buildFixJob({ namespace: "default", id, image: "ghcr.io/me/rigel-assistant:abc123", meta: META });
  const podSpec = (job.spec.template as { spec: Record<string, unknown> }).spec;
  const container = (podSpec.containers as Record<string, unknown>[])[0]!;

  test("is discoverable + traceable: the fix label + annotations round-trip", () => {
    expect(job.metadata.labels["app.kubernetes.io/managed-by"]).toBe("rigel-assistant");
    expect(job.metadata.labels[FIX_LABEL]).toBe("true");
    expect(readFixMeta(job.metadata.annotations)).toEqual(META);
  });

  test("is a one-shot Job: restartPolicy Never, backoffLimit 0, TTL set", () => {
    expect(job.kind).toBe("Job");
    expect(job.metadata.name).toBe(fixResourceName(id));
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(podSpec.restartPolicy).toBe("Never");
  });

  test("runs the fixRunner entry on the passed agent image", () => {
    expect(container.image).toBe("ghcr.io/me/rigel-assistant:abc123");
    expect(container.command).toEqual(["node", "/app/dist/fixRunner.js"]);
  });

  test("runs as the zero-RBAC rigel-fix-runner SA with no API token mounted", () => {
    expect(podSpec.serviceAccountName).toBe("rigel-fix-runner");
    expect(podSpec.automountServiceAccountToken).toBe(false);
  });

  test("references the rigel-github token by name (agent never reads it) + the spec ConfigMap", () => {
    const env = container.env as { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }[];
    const token = env.find((e) => e.name === "GITHUB_TOKEN");
    expect(token?.valueFrom?.secretKeyRef).toEqual({ name: "rigel-github", key: "token" });
    const mounts = container.volumeMounts as { name: string; mountPath: string }[];
    expect(mounts.some((m) => m.name === "fix-spec")).toBe(true);
    const volumes = podSpec.volumes as { name: string; configMap?: { name: string } }[];
    expect(volumes.find((v) => v.name === "fix-spec")?.configMap?.name).toBe(fixResourceName(id));
  });

  test("writes its result to the termination log path", () => {
    const env = container.env as { name: string; value?: string }[];
    expect(env.find((e) => e.name === "TERMINATION_LOG")?.value).toBe("/dev/termination-log");
    expect(container.terminationMessagePath).toBe("/dev/termination-log");
  });

  test("has CPU/memory limits", () => {
    const r = container.resources as { limits: Record<string, string> };
    expect(r.limits.cpu).toBeTruthy();
    expect(r.limits.memory).toBeTruthy();
  });
});
