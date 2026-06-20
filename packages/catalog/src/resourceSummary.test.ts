import { test, expect } from "vitest";
import { listResources, listResourceDocs, joinResourceDocs } from "./resourceSummary";

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

test("listResourceDocs pairs each ref with its document, joinResourceDocs round-trips", () => {
  const yaml = [
    "apiVersion: v1","kind: Namespace","metadata:","  name: m","---",
    "apiVersion: apps/v1","kind: Deployment","metadata:","  name: m","  namespace: m",
  ].join("\n");
  const docs = listResourceDocs(yaml);
  expect(docs.map((d) => d.kind)).toEqual(["Namespace", "Deployment"]);
  // Re-emitting all docs re-parses to the same resources.
  expect(listResources(joinResourceDocs(docs))).toEqual(listResources(yaml));
});

test("joinResourceDocs of a SUBSET drops the deselected resource (keep the Namespace)", () => {
  const yaml = [
    "apiVersion: v1","kind: Namespace","metadata:","  name: m","---",
    "apiVersion: apps/v1","kind: Deployment","metadata:","  name: m","  namespace: m","---",
    "apiVersion: v1","kind: PersistentVolumeClaim","metadata:","  name: m","  namespace: m",
  ].join("\n");
  const keep = listResourceDocs(yaml).filter((d) => d.kind !== "Namespace");
  expect(listResources(joinResourceDocs(keep))).toEqual([
    { kind: "Deployment", name: "m", namespace: "m" },
    { kind: "PersistentVolumeClaim", name: "m", namespace: "m" },
  ]);
});
