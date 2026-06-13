import { test, expect } from "bun:test";
import { extractActionBlocks, stripActionBlocks } from "./actionBlocks";

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
