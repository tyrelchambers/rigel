// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { stagedDiff, usePermissions } from "./usePermissions";
import { DEFAULT_POLICY, clusterRoleRules, serializePolicy, setCapability } from "@rigel/k8s";

test("stagedDiff reports pending changes vs the applied policy", () => {
  const next = setCapability(DEFAULT_POLICY, "deleteWorkloads", true);
  const d = stagedDiff(DEFAULT_POLICY, next);
  expect(d.count).toBeGreaterThan(0);
  expect(d.added.length).toBeGreaterThan(0);
  const none = stagedDiff(DEFAULT_POLICY, DEFAULT_POLICY);
  expect(none.count).toBe(0);
});

describe("stagedDiff", () => {
  test("counts both additions and removals", () => {
    const removedRead = { cells: DEFAULT_POLICY.cells.slice(1) };
    const d = stagedDiff(DEFAULT_POLICY, removedRead);
    expect(d.removed).toEqual([DEFAULT_POLICY.cells[0]]);
    expect(d.count).toBe(1);
  });
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function stubAssistantFetch(appliedRules: unknown = null) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/assistant")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { action?: string };
      if (body.action === "getRbac") {
        return new Response(
          JSON.stringify({
            success: true,
            stdout: JSON.stringify({ policy: serializePolicy(DEFAULT_POLICY), appliedRules }),
            stderr: "",
          }),
        );
      }
      if (body.action === "setRbac") {
        return new Response(JSON.stringify({ success: true, stdout: "", stderr: "" }));
      }
    }
    return new Response(JSON.stringify({}));
  });
}

function setRbacBody(fetchMock: ReturnType<typeof stubAssistantFetch>) {
  const call = fetchMock.mock.calls.find(([, init]) => {
    const body = JSON.parse(((init as RequestInit | undefined)?.body as string) ?? "{}");
    return body.action === "setRbac";
  });
  return call ? JSON.parse(((call[1] as RequestInit).body as string) ?? "{}") : undefined;
}

describe("usePermissions", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("apply sends the explicit contexts list and the staged policy", async () => {
    const fetchMock = stubAssistantFetch(null);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => usePermissions("default"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    result.current.apply(["ctx-a", "ctx-b"]);

    await waitFor(() => expect(setRbacBody(fetchMock)).toBeDefined());
    const body = setRbacBody(fetchMock);
    expect(body).toEqual(expect.objectContaining({ action: "setRbac", contexts: ["ctx-a", "ctx-b"] }));
    expect(body).not.toHaveProperty("rbacTarget");
  });

  test("drift is true when live appliedRules diverge from the stored policy", async () => {
    const drifted = clusterRoleRules(setCapability(DEFAULT_POLICY, "deleteWorkloads", true));
    vi.stubGlobal("fetch", stubAssistantFetch(drifted));

    const { result } = renderHook(() => usePermissions("default"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.drift).toBe(true);
  });

  test("drift is false when appliedRules is null (live read failed)", async () => {
    vi.stubGlobal("fetch", stubAssistantFetch(null));

    const { result } = renderHook(() => usePermissions("default"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.drift).toBe(false);
  });
});
