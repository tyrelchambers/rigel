import { test, expect } from "vitest";
import { listResources } from "./resourceSummary";

test("listResources returns kind/name/namespace per document", () => {
  const yaml = [
    "apiVersion: v1","kind: Namespace","metadata:","  name: affine","---",
    "apiVersion: apps/v1","kind: Deployment","metadata:","  name: affine-server","  namespace: affine","---",
    "apiVersion: v1","kind: Service","metadata:","  name: affine","  namespace: affine",
  ].join("\n");
  expect(listResources(yaml)).toEqual([
    { kind: "Namespace", name: "affine", namespace: undefined },
    { kind: "Deployment", name: "affine-server", namespace: "affine" },
    { kind: "Service", name: "affine", namespace: "affine" },
  ]);
});
test("listResources skips docs without a kind", () => {
  expect(listResources("# comment\n---\nkind: Pod\nmetadata:\n  name: p")).toEqual([
    { kind: "Pod", name: "p", namespace: undefined },
  ]);
});
