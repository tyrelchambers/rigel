import { test, expect, vi, beforeEach } from "vitest";
import { parseApiResources, getApiResources } from "./apiResources";
import { kubectl } from "@rigel/k8s/src/run";

vi.mock("@rigel/k8s/src/run", () => ({ kubectl: vi.fn() }));
const mockKubectl = vi.mocked(kubectl);

beforeEach(() => {
  mockKubectl.mockReset();
});

const SAMPLE = `
bindings                     v1              true    Binding
configmaps          cm       v1              true    ConfigMap
deployments         deploy   apps/v1         true    Deployment
events              ev       events.k8s.io/v1 true   Event
events              ev       v1              true    Event
`;

test("parseApiResources: parses the sample columnar output", () => {
  const { resources, groups } = parseApiResources(SAMPLE);
  expect(resources).toEqual(["bindings", "configmaps", "deployments", "events"]);
  expect(groups).toEqual(["apps", "core", "events.k8s.io"]);
});

test("parseApiResources: resource with no shortname parses correctly", () => {
  const { resources, groups } = parseApiResources("bindings                     v1              true    Binding");
  expect(resources).toEqual(["bindings"]);
  expect(groups).toEqual(["core"]);
});

test("parseApiResources: skips malformed/blank lines", () => {
  const stdout = `
configmaps          cm       v1              true    ConfigMap

garbage line with no namespaced column
`;
  const { resources, groups } = parseApiResources(stdout);
  expect(resources).toEqual(["configmaps"]);
  expect(groups).toEqual(["core"]);
});

test("parseApiResources: empty input → empty lists", () => {
  expect(parseApiResources("")).toEqual({ resources: [], groups: [] });
});

test("getApiResources: parses stdout on success", async () => {
  mockKubectl.mockResolvedValue({ code: 0, stdout: SAMPLE, stderr: "" });
  const result = await getApiResources("my-context");
  expect(mockKubectl).toHaveBeenCalledWith("my-context", ["api-resources", "--no-headers"]);
  expect(result.resources).toContain("deployments");
  expect(result.groups).toContain("apps");
});

test("getApiResources: non-zero exit → empty lists, never throws", async () => {
  mockKubectl.mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
  const result = await getApiResources(null);
  expect(result).toEqual({ resources: [], groups: [] });
});
