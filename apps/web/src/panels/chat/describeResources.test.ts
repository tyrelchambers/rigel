import { describe, it, expect } from "vitest";
import {
  DESCRIBE_KINDS,
  resolveDescribeKind,
  isNamespaced,
  describeTypeOptions,
  describeNamespaceOptions,
  describeInstanceOptions,
} from "./describeResources";

const RESOURCES: Record<string, unknown> = {
  namespaces: {
    default: { metadata: { name: "default" } },
    "kube-system": { metadata: { name: "kube-system" } },
    app: { metadata: { name: "app" } },
  },
  secrets: {
    "default/a": { metadata: { name: "tls-cert", namespace: "default" } },
    "default/b": { metadata: { name: "registry", namespace: "default" } },
    "app/c": { metadata: { name: "app-token", namespace: "app" } },
  },
};

describe("resolveDescribeKind", () => {
  it("matches singular and plural", () => {
    expect(resolveDescribeKind("ingress")?.kind).toBe("ingresses");
    expect(resolveDescribeKind("ingresses")?.kind).toBe("ingresses");
    expect(resolveDescribeKind("POD")?.kind).toBe("pods");
  });
  it("returns undefined for unknown types", () => {
    expect(resolveDescribeKind("widget")).toBeUndefined();
  });
});

describe("isNamespaced", () => {
  it("reflects scope", () => {
    expect(isNamespaced(resolveDescribeKind("pod")!)).toBe(true);
    expect(isNamespaced(resolveDescribeKind("node")!)).toBe(false);
    expect(isNamespaced(resolveDescribeKind("namespace")!)).toBe(false);
  });
});

describe("describeTypeOptions", () => {
  it("returns the whole curated set when empty", () => {
    expect(describeTypeOptions("", 99)).toHaveLength(DESCRIBE_KINDS.length);
  });
  it("ranks an exact/prefix match first", () => {
    expect(describeTypeOptions("secret")[0]?.value).toBe("secret");
    expect(describeTypeOptions("ing")[0]?.value).toBe("ingress");
  });
  it("carries a scope badge", () => {
    expect(describeTypeOptions("node")[0]?.badge).toBe("CLUSTER");
    expect(describeTypeOptions("pod")[0]?.badge).toBe("NS");
  });
});

describe("describeNamespaceOptions", () => {
  it("lists namespace names, sorted, when query is empty", () => {
    expect(describeNamespaceOptions(RESOURCES, "").map((o) => o.value)).toEqual(["app", "default", "kube-system"]);
  });
  it("filters by partial", () => {
    expect(describeNamespaceOptions(RESOURCES, "kube").map((o) => o.value)).toEqual(["kube-system"]);
  });
});

describe("describeInstanceOptions", () => {
  const secrets = resolveDescribeKind("secret")!;

  it("lists only instances in the given namespace", () => {
    const opts = describeInstanceOptions(RESOURCES, secrets, "default", "");
    expect(opts.map((o) => o.value).sort()).toEqual(["registry", "tls-cert"]);
    expect(opts.every((o) => o.namespace === "default")).toBe(true);
  });
  it("filters by the name partial", () => {
    expect(describeInstanceOptions(RESOURCES, secrets, "default", "tls").map((o) => o.value)).toEqual(["tls-cert"]);
  });
  it("carries the kind as a badge", () => {
    expect(describeInstanceOptions(RESOURCES, secrets, "default", "tls")[0]?.badge).toBe("SECRET");
  });
  it("returns nothing for a namespace with no instances", () => {
    expect(describeInstanceOptions(RESOURCES, secrets, "kube-system", "")).toEqual([]);
  });
});
