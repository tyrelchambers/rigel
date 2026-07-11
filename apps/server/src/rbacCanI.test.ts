import { test, expect, vi } from "vitest";
import { impersonationArgs, resourceArg, runCanI } from "./rbacCanI";

test("impersonationArgs: ServiceAccount / User / Group", () => {
  expect(impersonationArgs({ kind: "ServiceAccount", name: "deployer", namespace: "prod" }))
    .toEqual(["--as=system:serviceaccount:prod:deployer"]);
  expect(impersonationArgs({ kind: "User", name: "alice" })).toEqual(["--as=alice"]);
  expect(impersonationArgs({ kind: "Group", name: "devs" }))
    .toEqual(["--as=rigel:can-i-probe", "--as-group=devs"]);
});

test("resourceArg: grouped resource uses resource.group; core/'*' bare", () => {
  expect(resourceArg({ verb: "get", resource: "deployments", apiGroup: "apps" })).toBe("deployments.apps");
  expect(resourceArg({ verb: "get", resource: "pods", apiGroup: "" })).toBe("pods");
  expect(resourceArg({ verb: "*", resource: "*", apiGroup: "*" })).toBe("*");
});

test("runCanI: maps yes/no/unknown and namespace flag", async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ code: 0, stdout: "yes\n", stderr: "" })
    .mockResolvedValueOnce({ code: 1, stdout: "no\n", stderr: "" });
  const { results, note } = await runCanI(
    { kind: "ServiceAccount", name: "sa", namespace: "default" },
    [
      { verb: "get", resource: "pods", apiGroup: "", namespace: "default" },
      { verb: "create", resource: "deployments", apiGroup: "apps" },
    ],
    run,
  );
  expect(results.map((r) => r.allowed)).toEqual([true, false]);
  expect(run).toHaveBeenNthCalledWith(1, [
    "auth", "can-i", "get", "pods", "--as=system:serviceaccount:default:sa", "-n", "default",
  ]);
  expect(note).toBeUndefined();
});

test("runCanI: impersonation-forbidden → allowed null + note", async () => {
  const run = vi.fn().mockResolvedValue({
    code: 1, stdout: "", stderr: 'Error from server (Forbidden): users "me" cannot impersonate resource "serviceaccounts"',
  });
  const { results, note } = await runCanI(
    { kind: "ServiceAccount", name: "sa", namespace: "default" },
    [{ verb: "get", resource: "pods", apiGroup: "" }],
    run,
  );
  expect(results[0].allowed).toBeNull();
  expect(note).toMatch(/impersonate/i);
});
