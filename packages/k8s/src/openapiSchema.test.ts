import { test, expect } from "bun:test";
import { openapiV2ToYamlSchema, gvkApiVersion } from "./openapiSchema";

const SAMPLE = {
  definitions: {
    "io.k8s.api.apps.v1.Deployment": {
      type: "object",
      "x-kubernetes-group-version-kind": [{ group: "apps", version: "v1", kind: "Deployment" }],
      properties: { spec: { type: "object" } },
    },
    "io.k8s.api.core.v1.ConfigMap": {
      type: "object",
      "x-kubernetes-group-version-kind": [{ group: "", version: "v1", kind: "ConfigMap" }],
    },
    "io.k8s.apimachinery.SomeInternalType": { type: "object" }, // no GVK → skipped
  },
};

test("gvkApiVersion: core group omits the slash, others are group/version", () => {
  expect(gvkApiVersion({ group: "", version: "v1" })).toBe("v1");
  expect(gvkApiVersion({ group: "apps", version: "v1" })).toBe("apps/v1");
});

test("openapiV2ToYamlSchema builds one oneOf branch per GVK with const discriminators", () => {
  const schema = openapiV2ToYamlSchema(SAMPLE);
  expect(schema).not.toBeNull();
  const branches = schema!.oneOf as Array<Record<string, any>>;
  expect(branches).toHaveLength(2); // internal type with no GVK is skipped
  const deploy = branches.find((b) => b.properties.kind.const === "Deployment")!;
  expect(deploy.properties.apiVersion.const).toBe("apps/v1");
  expect(deploy.required).toEqual(["apiVersion", "kind"]);
  expect(deploy.allOf[0].$ref).toBe("#/definitions/io.k8s.api.apps.v1.Deployment");
  expect((schema!.definitions as Record<string, unknown>)["io.k8s.api.core.v1.ConfigMap"]).toBeDefined();
});

test("openapiV2ToYamlSchema returns null on junk input (→ lint-only)", () => {
  expect(openapiV2ToYamlSchema(null)).toBeNull();
  expect(openapiV2ToYamlSchema({})).toBeNull();
  expect(openapiV2ToYamlSchema({ definitions: {} })).toBeNull();
});

test("openapiV2ToYamlSchema emits a branch per GVK when a definition has several", () => {
  const schema = openapiV2ToYamlSchema({
    definitions: {
      "io.k8s.api.autoscaling.v1.Scale": {
        type: "object",
        "x-kubernetes-group-version-kind": [
          { group: "apps", version: "v1", kind: "Scale" },
          { group: "autoscaling", version: "v1", kind: "Scale" },
        ],
      },
    },
  })!;
  const branches = schema.oneOf as Array<Record<string, any>>;
  expect(branches).toHaveLength(2);
  expect(branches.map((b) => b.properties.apiVersion.const).sort()).toEqual(["apps/v1", "autoscaling/v1"]);
});
