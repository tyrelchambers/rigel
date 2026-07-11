import { describe, it, expect, vi } from "vitest";
import { discoverAccess } from "./access";

describe("discoverAccess", () => {
  it("returns cluster-wide when the user can list namespaces", async () => {
    const run = vi.fn(async (args: string[]) =>
      args.includes("namespaces")
        ? { code: 0, stdout: "yes\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const a = await discoverAccess({ context: "ctx", seedNamespaces: [], run });
    expect(a.mode).toBe("cluster-wide");
  });

  it("returns scoped with the seed namespaces when namespace listing is denied", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("namespaces")) return { code: 1, stdout: "no\n", stderr: "forbidden" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const a = await discoverAccess({ context: "ctx", seedNamespaces: ["team-a"], run });
    expect(a.mode).toBe("scoped");
    expect(a.namespaces).toEqual(["team-a"]);
  });

  it("caps the scoped namespace set at maxNamespaces", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "no\n", stderr: "forbidden" }));
    const a = await discoverAccess({
      context: null,
      seedNamespaces: ["a", "b", "c"],
      run,
      maxNamespaces: 2,
    });
    expect(a.mode).toBe("scoped");
    expect(a.namespaces).toEqual(["a", "b"]);
  });

  it("passes --context when a context is given, omits it when null", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "yes\n", stderr: "" };
    });
    await discoverAccess({ context: "kind-x", seedNamespaces: [], run });
    expect(calls[0]).toEqual(expect.arrayContaining(["--context", "kind-x", "auth", "can-i", "list", "namespaces"]));
    calls.length = 0;
    await discoverAccess({ context: null, seedNamespaces: [], run });
    expect(calls[0]).not.toContain("--context");
  });
});
