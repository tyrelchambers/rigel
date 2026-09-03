// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useIssueMutes } from "./useIssueMutes";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api";

function reply(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: "", json: async () => body } as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

afterEach(() => {
  cleanup();
  vi.mocked(apiFetch).mockReset();
});

describe("useIssueMutes", () => {
  it("reads the cluster's stored mutes", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ mutes: { "a|b": { until: null } } }));
    const { result } = renderHook(() => useIssueMutes(), { wrapper });
    await waitFor(() => expect(result.current.mutes).toEqual({ "a|b": { until: null } }));
  });

  it("is empty while the read is in flight", () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ mutes: { "a|b": { until: null } } }));
    const { result } = renderHook(() => useIssueMutes(), { wrapper });
    expect(result.current.mutes).toEqual({});
  });

  it("is empty when the cluster cannot be read", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ error: "no cluster to save to" }, false, 503));
    const { result } = renderHook(() => useIssueMutes(), { wrapper });
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    expect(result.current.mutes).toEqual({});
  });

  it("PUTs the whole map when one fingerprint is muted", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ mutes: {} }));
    const { result } = renderHook(() => useIssueMutes(), { wrapper });
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());

    vi.mocked(apiFetch).mockResolvedValue(reply({ mutes: { "a|b": { until: null } } }));
    result.current.mute("a|b", null);

    await waitFor(() => expect(result.current.mutes).toEqual({ "a|b": { until: null } }));
    const calls = vi.mocked(apiFetch).mock.calls;
    const [, init] = calls[calls.length - 1]!;
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ mutes: { "a|b": { until: null } } });
  });

  it("PUTs the map without the fingerprint when it is unmuted", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      reply({ mutes: { "a|b": { until: null }, "c|d": { until: null } } }),
    );
    const { result } = renderHook(() => useIssueMutes(), { wrapper });
    await waitFor(() => expect(Object.keys(result.current.mutes)).toHaveLength(2));

    result.current.unmute("a|b");

    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBe(2));
    const calls = vi.mocked(apiFetch).mock.calls;
    const [, init] = calls[calls.length - 1]!;
    expect(JSON.parse(String(init?.body))).toEqual({ mutes: { "c|d": { until: null } } });
  });

  it("sends a snooze as an instant in the future", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ mutes: {} }));
    const { result } = renderHook(() => useIssueMutes(), { wrapper });
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());

    result.current.mute("a|b", { hours: 24 });

    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBe(2));
    const calls = vi.mocked(apiFetch).mock.calls;
    const [, init] = calls[calls.length - 1]!;
    const sent = JSON.parse(String(init?.body)) as { mutes: Record<string, { until: string }> };
    expect(Date.parse(sent.mutes["a|b"].until)).toBeGreaterThan(Date.now());
  });
});
