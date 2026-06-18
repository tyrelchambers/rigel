import { test, it, expect, describe } from "vitest";
import {
  extractActionBlocks,
  stripActionBlocks,
  isDestructiveAction,
  extractQuestionBlocks,
  buildQuestionAnswer,
  extractAlertBlocks,
  parseSuggestedActions,
} from "./actionBlocks";

function questionBlock(json: unknown): string {
  return ["```question", JSON.stringify(json), "```"].join("\n");
}

const MSG = [
  "I'll set up AFFiNE.",
  "```action", '{"kind":"applyManifest","label":"Self-host AFFiNE"}', "```",
  "```yaml","apiVersion: v1","kind: Namespace","metadata:","  name: affine","```",
  "Click apply when ready.",
].join("\n");

test("applyManifest action gets the paired yaml attached as manifest", () => {
  const [a] = extractActionBlocks(MSG);
  expect(a.kind).toBe("applyManifest");
  expect(a.manifest).toContain("kind: Namespace");
});
test("strip removes BOTH the action and its paired yaml, keeps prose", () => {
  const s = stripActionBlocks(MSG);
  expect(s).not.toContain("```action");
  expect(s).not.toContain("```yaml");
  expect(s).not.toContain("kind: Namespace");
  expect(s).toContain("I'll set up AFFiNE.");
  expect(s).toContain("Click apply when ready.");
});
test("a non-applyManifest action does NOT consume a following yaml block", () => {
  const msg = ["```action", '{"kind":"restart","name":"web","namespace":"default","label":"Restart web"}', "```", "```yaml","kind: ConfigMap","```"].join("\n");
  const [a] = extractActionBlocks(msg);
  expect(a.manifest).toBeUndefined();
  expect(stripActionBlocks(msg)).toContain("kind: ConfigMap");
});
test("applyManifest with no following yaml is dropped (incomplete)", () => {
  expect(extractActionBlocks(["```action", '{"kind":"applyManifest","label":"x"}', "```"].join("\n"))).toEqual([]);
});

const FIX_MSG = [
  "The api deployment is OOMKilled. I'll bump its memory limit.",
  "```action", '{"kind":"proposeRepoFix","label":"Open PR: bump api memory","source":"my-app","filePath":"k8s/api.yaml","title":"Bump api memory limit","body":"OOMKilled; raise to 512Mi"}', "```",
  "```yaml", "apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: api", "```",
  "Review the PR before merging.",
].join("\n");

test("proposeRepoFix attaches the paired file content + parses fields", () => {
  const [a] = extractActionBlocks(FIX_MSG);
  expect(a.kind).toBe("proposeRepoFix");
  expect(a.source).toBe("my-app");
  expect(a.filePath).toBe("k8s/api.yaml");
  expect(a.title).toBe("Bump api memory limit");
  expect(a.content).toContain("kind: Deployment");
});
test("proposeRepoFix strips action + paired content, keeps prose", () => {
  const s = stripActionBlocks(FIX_MSG);
  expect(s).not.toContain("```action");
  expect(s).not.toContain("kind: Deployment");
  expect(s).toContain("OOMKilled");
  expect(s).toContain("Review the PR before merging.");
});
test("proposeRepoFix with no following block is dropped (incomplete)", () => {
  expect(extractActionBlocks(["```action", '{"kind":"proposeRepoFix","label":"x","source":"a","filePath":"f"}', "```"].join("\n"))).toEqual([]);
});

test("isDestructiveAction: delete/drain/purge family is always destructive", () => {
  for (const kind of ["deletePod", "deleteWorkload", "deleteNamespace", "deleteResource", "drain", "purge"]) {
    expect(isDestructiveAction({ kind })).toBe(true);
    // a false hint can never downgrade an inherently destructive kind
    expect(isDestructiveAction({ kind, destructive: false })).toBe(true);
  }
});
test("isDestructiveAction: non-destructive kinds follow the model's hint", () => {
  expect(isDestructiveAction({ kind: "restart" })).toBe(false);
  expect(isDestructiveAction({ kind: "scale" })).toBe(false);
  expect(isDestructiveAction({ kind: "command" })).toBe(false);
  expect(isDestructiveAction({ kind: "command", destructive: true })).toBe(true);
});

// --- question blocks: fields parsing -----------------------------------------

test("extractQuestionBlocks: fieldless options still parse (no fields key)", () => {
  const [q] = extractQuestionBlocks(
    questionBlock({ question: "Pick one", options: [{ label: "A" }, { label: "B", value: "Bee" }] }),
  );
  expect(q.question).toBe("Pick one");
  expect(q.options).toEqual([
    { label: "A", value: undefined, fields: undefined },
    { label: "B", value: "Bee", fields: undefined },
  ]);
});

test("extractQuestionBlocks: well-formed fields keep name/label/placeholder/required in order", () => {
  const [q] = extractQuestionBlocks(
    questionBlock({
      question: "How?",
      options: [
        {
          label: "Deploy",
          value: "Deploy it",
          fields: [
            { name: "hostname", label: "Public hostname", placeholder: "affine.example.com", required: true },
            { name: "port", label: "Service port", placeholder: "3010", required: false },
          ],
        },
      ],
    }),
  );
  expect(q.options[0]!.fields).toEqual([
    { name: "hostname", label: "Public hostname", placeholder: "affine.example.com", required: true },
    { name: "port", label: "Service port", placeholder: "3010", required: false },
  ]);
});

test("extractQuestionBlocks: required defaults to true when absent, honors explicit false", () => {
  const [q] = extractQuestionBlocks(
    questionBlock({
      question: "How?",
      options: [{ label: "X", fields: [{ name: "a" }, { name: "b", required: false }] }],
    }),
  );
  expect(q.options[0]!.fields![0]!.required).toBe(true);
  expect(q.options[0]!.fields![1]!.required).toBe(false);
});

test("extractQuestionBlocks: malformed fields dropped, survivors kept in order", () => {
  const [q] = extractQuestionBlocks(
    questionBlock({
      question: "How?",
      options: [
        {
          label: "X",
          fields: [
            "nope",
            { name: 42 },
            { label: "no name" },
            { name: "host" },
            { name: "port", label: 99, placeholder: true, required: "yes" },
          ],
        },
      ],
    }),
  );
  // non-object, non-string name, missing name → dropped. host kept; port kept
  // but its bad label/placeholder dropped and bad required defaults to true.
  expect(q.options[0]!.fields).toEqual([
    { name: "host", label: undefined, placeholder: undefined, required: true },
    { name: "port", label: undefined, placeholder: undefined, required: true },
  ]);
});

test("extractQuestionBlocks: all-dropped fields degrade option to plain (fields undefined)", () => {
  const [q] = extractQuestionBlocks(
    questionBlock({ question: "How?", options: [{ label: "X", fields: [{ label: "no name" }, "bad"] }] }),
  );
  expect(q.options[0]!.fields).toBeUndefined();
});

test("extractQuestionBlocks: empty array fields degrades to plain", () => {
  const [q] = extractQuestionBlocks(
    questionBlock({ question: "How?", options: [{ label: "X", fields: [] }] }),
  );
  expect(q.options[0]!.fields).toBeUndefined();
});

test("extractQuestionBlocks: non-array fields is ignored (plain option)", () => {
  const [q] = extractQuestionBlocks(
    questionBlock({ question: "How?", options: [{ label: "X", fields: "nope" }] }),
  );
  expect(q.options).toHaveLength(1);
  expect(q.options[0]!.fields).toBeUndefined();
});

// --- buildQuestionAnswer -----------------------------------------------------

test("buildQuestionAnswer: fieldless equals today's `> question\\n value ?? label`", () => {
  expect(buildQuestionAnswer("Q?", { label: "Lab" }, {})).toBe("> Q?\nLab");
  expect(buildQuestionAnswer("Q?", { label: "Lab", value: "Val" }, {})).toBe("> Q?\nVal");
});

test("buildQuestionAnswer: with values emits name: value lines in field order", () => {
  const option = {
    label: "Deploy",
    value: "Deploy AFFiNE and expose it",
    fields: [
      { name: "hostname", required: true },
      { name: "port", required: false },
    ],
  };
  expect(
    buildQuestionAnswer(
      "There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?",
      option,
      { hostname: "affine.example.com", port: "3010" },
    ),
  ).toBe(
    [
      "> There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?",
      "Deploy AFFiNE and expose it",
      "hostname: affine.example.com",
      "port: 3010",
    ].join("\n"),
  );
});

test("buildQuestionAnswer: blank/whitespace field omitted; filled kept", () => {
  const option = {
    label: "Deploy",
    value: "Deploy AFFiNE and expose it",
    fields: [
      { name: "hostname", required: true },
      { name: "port", required: false },
    ],
  };
  expect(
    buildQuestionAnswer("There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?", option, {
      hostname: "affine.example.com",
      port: "   ",
    }),
  ).toBe(
    [
      "> There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?",
      "Deploy AFFiNE and expose it",
      "hostname: affine.example.com",
    ].join("\n"),
  );
});

describe("extractAlertBlocks", () => {
  const md = [
    "Sure — I'll set that up.",
    "```alert",
    JSON.stringify({
      label: "Alert: postgres down",
      text: "text me if postgres in prod goes down",
      target: { scope: "database", namespace: "prod", name: "postgres" },
      condition: { type: "notReady", minutes: 2 },
    }),
    "```",
  ].join("\n");

  it("extracts a valid alert block", () => {
    const alerts = extractAlertBlocks(md);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.target.name).toBe("postgres");
  });
  it("drops blocks missing label/text/target/condition", () => {
    expect(extractAlertBlocks("```alert\n{\"label\":\"x\"}\n```")).toEqual([]);
    expect(extractAlertBlocks("```alert\nnot json\n```")).toEqual([]);
  });
  it("stripActionBlocks removes the alert fence from display text", () => {
    expect(stripActionBlocks(md)).toBe("Sure — I'll set that up.");
  });
  it("parseSuggestedActions returns alerts alongside actions/questions", () => {
    expect(parseSuggestedActions(md).alerts).toHaveLength(1);
  });
});
