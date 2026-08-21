import { describe, expect, test } from "vitest";
import * as z from "zod";
import { ACTION_KINDS, type SuggestedAction } from "./actionBlocks";
import { actionSchema } from "./actionSchema";

/** Every discriminator value the union accepts, however the variant spells it. */
function kindsInSchema(): string[] {
  return actionSchema.options.flatMap((option) => {
    const kind = (option as unknown as { shape: { kind: { options?: string[]; value?: string } } }).shape.kind;
    return kind.options ?? [kind.value!];
  });
}

/**
 * One fully populated action per kind, with every field the server consumes.
 * These are the anti-stripping fixtures: zod objects drop unknown keys, so a
 * field missing from the schema would vanish before the tool ever saw it, and
 * the round-trip below is what catches that.
 */
const CANONICAL: Record<string, SuggestedAction> = {
  restart: { label: "Restart web", kind: "restart", name: "web", namespace: "default", resourceKind: "deployment" },
  rollback: { label: "Roll back web", kind: "rollback", name: "web", namespace: "default" },
  pause: { label: "Pause web", kind: "pause", name: "web", namespace: "default" },
  resume: { label: "Resume web", kind: "resume", name: "web", namespace: "default" },
  scale: { label: "Scale web", kind: "scale", name: "web", namespace: "default", resourceKind: "deployment", replicas: 3 },
  setImage: {
    label: "Update web", kind: "setImage", name: "web", namespace: "default", resourceKind: "deployment",
    container: "web", image: "ghcr.io/acme/web:1.2.0",
  },
  setEnv: {
    label: "Set PORT", kind: "setEnv", name: "web", namespace: "default", container: "web",
    env: { PORT: "8080" }, unsetEnv: ["OLD_FLAG"],
  },
  setResources: {
    label: "Right-size web", kind: "setResources", name: "web", namespace: "default", resourceKind: "deployment",
    container: "web", requests: "cpu=250m,memory=512Mi", limits: "cpu=500m,memory=1Gi",
  },
  setImagePullSecrets: {
    label: "Set pull secrets", kind: "setImagePullSecrets", name: "web", namespace: "default",
    resourceKind: "deployment", imagePullSecrets: ["ghcr-creds"],
  },
  setEnvRef: {
    label: "Wire DB_URL", kind: "setEnvRef", name: "web", namespace: "default", resourceKind: "deployment",
    container: "web",
    envRefs: [{ name: "DB_URL", source: "secret", resourceName: "db", key: "url" }],
  },
  annotate: {
    label: "Annotate web", kind: "annotate", name: "web", namespace: "default", resourceKind: "deployment",
    annotations: { "example.com/owner": "platform", "example.com/old": null },
  },
  label: {
    label: "Label web", kind: "label", name: "web", namespace: "default", resourceKind: "deployment",
    labels: { tier: "front", legacy: null },
  },
  suspendCronJob: { label: "Suspend nightly", kind: "suspendCronJob", name: "nightly", namespace: "jobs" },
  resumeCronJob: { label: "Resume nightly", kind: "resumeCronJob", name: "nightly", namespace: "jobs" },
  triggerCronJob: { label: "Run nightly", kind: "triggerCronJob", name: "nightly", namespace: "jobs", pod: "nightly-manual" },
  cordon: { label: "Cordon node", kind: "cordon", node: "worker-3" },
  uncordon: { label: "Uncordon node", kind: "uncordon", node: "worker-3" },
  drain: { label: "Drain node", kind: "drain", node: "worker-3" },
  deletePod: { label: "Delete web-1", kind: "deletePod", pod: "web-1", namespace: "default" },
  deleteWorkload: { label: "Delete web", kind: "deleteWorkload", name: "web", namespace: "default", resourceKind: "deployment" },
  deleteResource: { label: "Delete svc web", kind: "deleteResource", name: "web", namespace: "default", resourceKind: "service" },
  createNamespace: { label: "Create staging", kind: "createNamespace", name: "staging" },
  deleteNamespace: { label: "Delete staging", kind: "deleteNamespace", name: "staging" },
  purge: { label: "Purge memos", kind: "purge", name: "memos", namespace: "default" },
  command: { label: "Patch web", kind: "command", args: ["patch", "deployment/web", "-n", "default"] },
  applyManifest: { label: "Install memos", kind: "applyManifest", manifest: "apiVersion: v1\nkind: Namespace\n" },
  proposeRepoFix: {
    label: "Open a PR", kind: "proposeRepoFix", name: "web", namespace: "shop", resourceKind: "deployment",
    source: "shop-web-82b3ade", title: "Annotate web", body: "asked for over voice",
    edit: { op: "annotate", annotations: { "example.com/owner": "platform" } },
  },
};

describe("actionSchema covers the contract", () => {
  test("the union's kinds are exactly ACTION_KINDS, in both directions", () => {
    expect([...kindsInSchema()].sort()).toEqual([...ACTION_KINDS].sort());
  });

  test("a canonical action of every kind survives a round trip with no field stripped", () => {
    for (const kind of ACTION_KINDS) {
      const action = CANONICAL[kind];
      expect(action, `no canonical fixture for ${kind}`).toBeDefined();
      expect(actionSchema.parse(action), kind).toEqual(action);
    }
  });

  // A live session was rejected for the button text while having the change
  // itself right. label is display only and every surface falls back, so it
  // must never cost one of the three tool calls a turn gets.
  test("an action with no label is accepted, because the label is only display", () => {
    const { label: _drop, ...noLabel } = CANONICAL.proposeRepoFix as unknown as Record<string, unknown>;
    expect(actionSchema.safeParse(noLabel).success).toBe(true);
  });

  test("the model's destructive hint is carried on any kind", () => {
    expect(actionSchema.parse({ ...CANONICAL.restart, destructive: true })).toMatchObject({ destructive: true });
  });
});

describe("actionSchema rejections name only what is wrong", () => {
  const failure = (action: unknown): string => {
    const result = actionSchema.safeParse(action);
    expect(result.success).toBe(false);
    return JSON.stringify(result.error!.issues);
  };

  // The field report: a model invented `kind: "patch"` twice and gave up,
  // because nothing told it what the kinds were.
  test("an invented kind is told every kind there is", () => {
    const message = failure({ label: "Patch web", kind: "patch", name: "web" });
    for (const kind of ["restart", "annotate", "command", "proposeRepoFix"]) expect(message).toContain(kind);
  });

  // The other field report: sourceId for source, and a refusal that listed all
  // four required fields left the model nothing to correct.
  test("a misspelled field names that field and not the ones that were right", () => {
    const { source: _drop, ...rest } = CANONICAL.proposeRepoFix as unknown as Record<string, unknown>;
    const message = failure({ ...rest, sourceId: "shop-web-82b3ade" });
    expect(message).toContain("source");
    expect(message).not.toContain("title");
    expect(message).not.toContain("name");
  });

  test("an edit sent as an array names edit", () => {
    const message = failure({ ...CANONICAL.proposeRepoFix, edit: [{ op: "annotate", annotations: {} }] });
    expect(message).toContain("edit");
  });

  test("a replica count that is not a number names replicas", () => {
    expect(failure({ ...CANONICAL.scale, replicas: "three" })).toContain("replicas");
  });

  test("deleteResource without its resourceKind names resourceKind", () => {
    const { resourceKind: _drop, ...rest } = CANONICAL.deleteResource as unknown as Record<string, unknown>;
    expect(failure(rest)).toContain("resourceKind");
  });

  test("applyManifest with nothing to apply names manifest", () => {
    const { manifest: _drop, ...rest } = CANONICAL.applyManifest as unknown as Record<string, unknown>;
    expect(failure(rest)).toContain("manifest");
  });
});

describe("actionSchema survives the SDK's own conversion", () => {
  // The exact call @livekit/agents makes in dist/llm/zod-utils.js. If a future
  // schema change stops converting, the model silently loses its guardrail.
  const converted = () =>
    z.toJSONSchema(z.object({ action: actionSchema }), { target: "draft-7", io: "output", reused: "inline" });

  test("converts to a draft-7 oneOf the provider can read", () => {
    const json = converted() as unknown as { properties: { action: { anyOf?: unknown[]; oneOf?: unknown[] } } };
    const variants = json.properties.action.oneOf ?? json.properties.action.anyOf;
    expect(variants).toBeDefined();
    expect(variants!.length).toBeGreaterThan(15);
  });

  test("stays inside its size budget, because every turn pays for it", () => {
    expect(JSON.stringify(converted()).length).toBeLessThan(10_000);
  });
});
