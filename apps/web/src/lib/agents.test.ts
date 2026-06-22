// @vitest-environment jsdom
// apps/web/src/lib/agents.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { connectionLabel, useSetActiveAgent, type AgentsResponse } from "./api";

describe("connectionLabel", () => {
  it("maps connection states to display labels", () => {
    expect(connectionLabel("connected")).toBe("Connected");
    expect(connectionLabel("notConnected")).toBe("Not connected");
    expect(connectionLabel("comingSoon")).toBe("Coming soon");
  });
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

describe("useSetActiveAgent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the chosen id to /api/agents/active and returns the new active state", async () => {
    const response: AgentsResponse = {
      activeAgentId: "codex",
      agents: [
        {
          id: "codex",
          label: "Codex",
          vendor: "OpenAI",
          status: "available",
          connection: "connected",
          authMethods: ["subscription", "apiKey"],
          authMethod: "subscription",
          installUrl: "https://x",
          installLabel: "Install Codex",
        },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));

    const { result } = renderHook(() => useSetActiveAgent(), { wrapper: wrapper() });
    const data = await result.current.mutateAsync("codex");

    expect(data.activeAgentId).toBe("codex");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/agents/active");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ id: "codex" });
  });

  it("throws the server error message on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
    );
    const { result } = renderHook(() => useSetActiveAgent(), { wrapper: wrapper() });
    await expect(result.current.mutateAsync("codex")).rejects.toThrow("nope");
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
