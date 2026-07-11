import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import { useCluster } from "@/store/cluster";

describe("apiFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useCluster.setState({ activeContext: null });
  });

  function headerFor(name: string): string | null {
    const mock = fetch as unknown as ReturnType<typeof vi.fn>;
    const init = mock.mock.calls[0][1] as RequestInit | undefined;
    return new Headers(init?.headers).get(name);
  }

  it("adds X-Rigel-Context when a context is active", async () => {
    useCluster.setState({ activeContext: "team-cluster" });
    await apiFetch("/api/x");
    expect(fetch).toHaveBeenCalledWith("/api/x", expect.anything());
    expect(headerFor("X-Rigel-Context")).toBe("team-cluster");
  });

  it("adds no context header when activeContext is null", async () => {
    useCluster.setState({ activeContext: null });
    await apiFetch("/api/x");
    expect(headerFor("X-Rigel-Context")).toBeNull();
  });

  it("preserves caller-provided headers alongside the context header", async () => {
    useCluster.setState({ activeContext: "team-cluster" });
    await apiFetch("/api/x", { headers: { "Content-Type": "application/json" } });
    expect(headerFor("Content-Type")).toBe("application/json");
    expect(headerFor("X-Rigel-Context")).toBe("team-cluster");
  });
});
