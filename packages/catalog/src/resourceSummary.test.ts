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

test("listResources reads name/namespace under any block indentation (not just 2 spaces)", () => {
  const fourSpace = [
    "apiVersion: policy/v1","kind: PodDisruptionBudget","metadata:",
    "    name: web-pdb","    namespace: default","spec:","    minAvailable: 1",
  ].join("\n");
  expect(listResources(fourSpace)).toEqual([
    { kind: "PodDisruptionBudget", name: "web-pdb", namespace: "default" },
  ]);
});

test("listResources reads name/namespace from an inline (flow) metadata mapping", () => {
  const flow = [
    "apiVersion: policy/v1","kind: PodDisruptionBudget",
    "metadata: {name: web-pdb, namespace: default}","spec:","  minAvailable: 1",
  ].join("\n");
  expect(listResources(flow)).toEqual([
    { kind: "PodDisruptionBudget", name: "web-pdb", namespace: "default" },
  ]);
});

test("listResources does not mistake a nested labels.name for the resource name", () => {
  const yaml = [
    "apiVersion: apps/v1","kind: Deployment","metadata:",
    "  labels:","    name: not-the-resource-name","  name: real-name","  namespace: ns",
    "spec:","  replicas: 1",
  ].join("\n");
  expect(listResources(yaml)).toEqual([
    { kind: "Deployment", name: "real-name", namespace: "ns" },
  ]);
});

test("listResources strips surrounding quotes from name/namespace", () => {
  const yaml = [
    'apiVersion: v1',"kind: ConfigMap","metadata:",'  name: "quoted-cm"',"  namespace: 'ns'",
  ].join("\n");
  expect(listResources(yaml)).toEqual([
    { kind: "ConfigMap", name: "quoted-cm", namespace: "ns" },
  ]);
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
