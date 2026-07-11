import { test, expect } from "vitest";
import { rulesToChecks } from "./canI";

test("rulesToChecks: expands rules to deduped verb×resource checks", () => {
  const checks = rulesToChecks(
    [
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "create"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["get"] },
    ],
    "prod",
  );
  expect(checks).toEqual([
    { verb: "get", resource: "deployments", apiGroup: "apps", namespace: "prod" },
    { verb: "create", resource: "deployments", apiGroup: "apps", namespace: "prod" },
    { verb: "get", resource: "pods", apiGroup: "", namespace: "prod" },
  ]);
});

test("rulesToChecks: dedupes repeats and caps the count", () => {
  const rule = { apiGroups: [""], resources: ["pods"], verbs: ["get", "get", "list"] };
  expect(rulesToChecks([rule, rule])).toHaveLength(2);
  const big = { apiGroups: [""], resources: Array.from({ length: 40 }, (_, i) => `r${i}`), verbs: ["get"] };
  expect(rulesToChecks([big], undefined, 24)).toHaveLength(24);
});

test("rulesToChecks: keeps '*' verb/resource entries", () => {
  expect(rulesToChecks([{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }]))
    .toEqual([{ verb: "*", resource: "*", apiGroup: "*", namespace: undefined }]);
});
