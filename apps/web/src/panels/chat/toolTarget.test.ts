import { describe, it, expect } from "vitest";
import { parseCommandTarget } from "./toolTarget";

describe("parseCommandTarget", () => {
  it("pulls context and namespace from a kubectl command", () => {
    expect(parseCommandTarget("kubectl --context prod-cluster -n default get pods")).toEqual({
      context: "prod-cluster",
      namespace: "default",
    });
  });

  it("reads the --namespace= form", () => {
    expect(parseCommandTarget("kubectl --context=prod --namespace=kube-system get svc")).toEqual({
      context: "prod",
      namespace: "kube-system",
    });
  });

  it("returns context only when there is no namespace flag", () => {
    expect(parseCommandTarget("kubectl --context prod get nodes")).toEqual({ context: "prod" });
  });

  it("returns nothing for a non-kubectl command", () => {
    expect(parseCommandTarget("echo hello")).toEqual({});
  });

  it("returns nothing for an undefined command", () => {
    expect(parseCommandTarget(undefined)).toEqual({});
  });
});
