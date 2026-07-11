import { test, expect, vi, beforeEach } from "vitest";
import { parseApiResources, getApiResources } from "./apiResources";
import { kubectl } from "@rigel/k8s/src/run";

vi.mock("@rigel/k8s/src/run", () => ({ kubectl: vi.fn() }));
const mockKubectl = vi.mocked(kubectl);

beforeEach(() => {
  mockKubectl.mockReset();
});

const SAMPLE = `
bindings                     v1              true    Binding      create,delete,get
configmaps          cm       v1              true    ConfigMap    create,delete,deletecollection,get,list,patch,update,watch  all
deployments         deploy   apps/v1         true    Deployment   create,delete,deletecollection,get,list,patch,update,watch  all
events              ev       events.k8s.io/v1 true   Event        get,list,watch
events              ev       v1              true    Event        create,patch,update
`;

test("parseApiResources: parses names, groups, and per-resource verbs", () => {
  const { resources, groups, verbsByResource } = parseApiResources(SAMPLE);
  expect(resources).toEqual(["bindings", "configmaps", "deployments", "events"]);
  expect(groups).toEqual(["apps", "core", "events.k8s.io"]);
  expect(verbsByResource["deployments"]).toEqual([
    "create", "delete", "deletecollection", "get", "list", "patch", "update", "watch",
  ]);
  // same resource name under two apiVersions → unioned + sorted
  expect(verbsByResource["events"]).toEqual(["create", "get", "list", "patch", "update", "watch"]);
});

test("parseApiResources: resource with no shortname parses verbs", () => {
  const { resources, verbsByResource } = parseApiResources(
    "bindings                     v1              true    Binding      create,delete,get",
  );
  expect(resources).toEqual(["bindings"]);
  expect(verbsByResource["bindings"]).toEqual(["create", "delete", "get"]);
});

test("parseApiResources: skips malformed/blank lines", () => {
  const stdout = `
configmaps          cm       v1              true    ConfigMap    create,delete,deletecollection,get,list,patch,update,watch  all

garbage line with no namespaced column
`;
  const { resources, groups } = parseApiResources(stdout);
  expect(resources).toEqual(["configmaps"]);
  expect(groups).toEqual(["core"]);
});

test("parseApiResources: empty input → empty result", () => {
  expect(parseApiResources("")).toEqual({ resources: [], groups: [], verbsByResource: {} });
});

test("getApiResources: requests -o wide and parses on success", async () => {
  mockKubectl.mockResolvedValue({ code: 0, stdout: SAMPLE, stderr: "" });
  const result = await getApiResources("my-context");
  expect(mockKubectl).toHaveBeenCalledWith("my-context", ["api-resources", "-o", "wide", "--no-headers"]);
  expect(result.verbsByResource["deployments"]).toContain("patch");
});

test("getApiResources: non-zero exit → empty result, never throws", async () => {
  mockKubectl.mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
  expect(await getApiResources(null)).toEqual({ resources: [], groups: [], verbsByResource: {} });
});
