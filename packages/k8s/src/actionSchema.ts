// The action vocabulary as a schema, not as prose.
//
// A voice tool that takes `z.record(z.string(), z.unknown())` tells the model
// nothing about the object that matters, so it guesses field names. Two live
// sessions were lost that way: one invented `kind: "patch"` and gave up, the
// other spelled `source` as `sourceId` and burned its whole three-tool-step
// budget on a refusal that listed all four required fields without saying which
// was wrong. Both were patched at the boundary. This is the fix.
//
// @livekit/agents runs `parseZodSchema` before a tool's execute, so the model
// sees the field names up front AND gets a rejection naming only what it got
// wrong, for every kind, without a line of refusal text.
//
// Two rules keep it honest:
//   - Every field the server consumes must appear here. zod objects STRIP
//     unknown keys, so a field left out of a variant is dropped before execute
//     ever sees it. actionSchema.test.ts round-trips a fully populated action
//     per kind to catch that.
//   - No `.refine()`. Refinements do not survive `toJSONSchema`, so they would
//     advertise a schema looser than the one that actually runs.
//
// The shapes are derived from `buildCommand` in apps/server/src/actions.ts,
// which is what actually consumes them, and from apps/CONTRACTS.md.

import * as z from "zod";
import { ACTION_KINDS } from "./actionBlocks";
import type { ManifestEdit } from "./manifestEdit";

/** A metadata map where a null value removes the key (kubectl's `key-`). */
const nullableMap = z.record(z.string(), z.union([z.string(), z.null()]));

/** Carried by every kind: the button text, and the model's own risk hint. */
const base = {
  label: z.string(),
  destructive: z.boolean().optional(),
};

/** Namespaced kinds. Cluster-scoped ones (nodes, namespaces) leave it out. */
const namespaced = { ...base, namespace: z.string().optional() };

/** The workload's kind when it is not a Deployment. */
const resourceKind = z.string().optional();

const manifestEditSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("annotate"),
    annotations: nullableMap.describe("a null value removes the annotation"),
  }),
  z.object({ op: z.literal("label"), labels: nullableMap.describe("a null value removes the label") }),
  z.object({ op: z.literal("setImage"), container: z.string().optional(), image: z.string() }),
  z.object({ op: z.literal("scale"), replicas: z.int().min(0) }),
]);

export type { ManifestEdit };

const variants = [
  z.object({ ...namespaced, kind: z.literal("restart"), name: z.string(), resourceKind }),
  z.object({ ...namespaced, kind: z.enum(["rollback", "pause", "resume"]), name: z.string() }),
  z.object({ ...namespaced, kind: z.literal("scale"), name: z.string(), resourceKind, replicas: z.int().min(0) }),
  z.object({
    ...namespaced,
    kind: z.literal("setImage"),
    name: z.string(),
    resourceKind,
    container: z.string(),
    image: z.string().describe("full image reference including the tag"),
  }),
  z.object({
    ...namespaced,
    kind: z.literal("setEnv"),
    name: z.string(),
    container: z.string().optional(),
    env: z.record(z.string(), z.string()),
    unsetEnv: z.array(z.string()).optional().describe("variables to remove"),
  }),
  z.object({
    ...namespaced,
    kind: z.literal("setResources"),
    name: z.string(),
    resourceKind,
    container: z.string(),
    requests: z.string().optional().describe('kubectl quantities, e.g. "cpu=250m,memory=512Mi"'),
    limits: z.string().optional(),
  }),
  z.object({
    ...namespaced,
    kind: z.literal("setImagePullSecrets"),
    name: z.string(),
    resourceKind,
    imagePullSecrets: z.array(z.string()).describe("the full desired list; an empty array clears it"),
  }),
  z.object({
    ...namespaced,
    kind: z.literal("setEnvRef"),
    name: z.string(),
    resourceKind,
    container: z.string(),
    envRefs: z.array(
      z.object({
        name: z.string(),
        source: z.enum(["secret", "configMap"]),
        resourceName: z.string(),
        key: z.string(),
      }),
    ),
  }),
  z.object({ ...namespaced, kind: z.literal("annotate"), name: z.string(), resourceKind, annotations: nullableMap }),
  z.object({ ...namespaced, kind: z.literal("label"), name: z.string(), resourceKind, labels: nullableMap }),
  z.object({ ...namespaced, kind: z.enum(["suspendCronJob", "resumeCronJob"]), name: z.string() }),
  z.object({
    ...namespaced,
    kind: z.literal("triggerCronJob"),
    name: z.string(),
    pod: z.string().optional().describe("name for the created Job"),
  }),
  z.object({ ...base, kind: z.enum(["cordon", "uncordon", "drain"]), node: z.string() }),
  z.object({ ...namespaced, kind: z.literal("deletePod"), pod: z.string() }),
  z.object({ ...namespaced, kind: z.literal("deleteWorkload"), name: z.string(), resourceKind }),
  z.object({
    ...namespaced,
    kind: z.literal("deleteResource"),
    name: z.string(),
    resourceKind: z.string().describe('the resource type, e.g. "service", "configmap", "pvc"'),
  }),
  z.object({ ...base, kind: z.enum(["createNamespace", "deleteNamespace"]), name: z.string() }),
  z.object({ ...namespaced, kind: z.literal("purge"), name: z.string() }),
  z.object({
    ...base,
    kind: z.literal("command"),
    args: z.array(z.string()).describe("literal kubectl arguments, without the binary or --context"),
  }),
  z.object({ ...base, kind: z.literal("applyManifest"), manifest: z.string().describe("complete manifest YAML") }),
  z.object({
    ...namespaced,
    kind: z.literal("proposeRepoFix"),
    name: z.string().describe("the workload the change targets"),
    resourceKind,
    source: z.string().describe("the source id checkGitLink returned"),
    title: z.string(),
    body: z.string().optional(),
    edit: manifestEditSchema,
  }),
] as const;

/**
 * Every action kind, discriminated by `kind`. The model is constrained to this,
 * so a wrong kind comes back naming all the valid ones and a wrong field comes
 * back naming that field.
 */
export const actionSchema = z.discriminatedUnion("kind", variants);

export type SchemaAction = z.infer<typeof actionSchema>;

/** The manifest edit shapes, pinned to ManifestEdit so the two cannot drift. */
export const manifestEdit = manifestEditSchema satisfies z.ZodType<ManifestEdit>;

/** Guards the union against a kind added to ACTION_KINDS and forgotten here. */
export type _KindsCovered = SchemaAction["kind"] extends (typeof ACTION_KINDS)[number] ? true : never;
