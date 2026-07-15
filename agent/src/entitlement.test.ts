import { afterEach, describe, expect, test, vi } from "vitest";
import type { Config } from "./config.js";
import {
  determineEntitlement,
  fetchEntitlement,
  parseEntitlement,
  readEntitlementCache,
  resolveEntitlement,
  shouldRefetch,
  writeEntitlementCache,
  type Entitlement,
} from "./entitlement.js";
import { kubectl } from "./kubectl.js";

vi.mock("./kubectl.js", () => {
  const kubectl = vi.fn();
  return { kubectl, kubectlApply: (manifest: string) => kubectl(["apply", "-f", "-"], manifest) };
});

const CFG = {
  stateConfigMap: "assistant-state",
  stateNamespace: "default",
  entitlementCheckMs: 12 * 60 * 60 * 1000,
  entitlementGraceMs: 30 * 24 * 60 * 60 * 1000,
  entitlementEndpoint: "https://api.rigel.run",
  agentToken: "tok",
} as unknown as Config;

const NOW = Date.parse("2026-07-15T00:00:00.000Z");
const ent = (agentEntitled: boolean, ageMs = 0): Entitlement => ({
  agentEntitled,
  fetchedAt: new Date(NOW - ageMs).toISOString(),
});

afterEach(() => vi.clearAllMocks());

describe("resolveEntitlement", () => {
  const cases: Array<{ name: string; cache: Entitlement | null; fetch: Parameters<typeof resolveEntitlement>[0]["fetchResult"]; want: boolean }> = [
    { name: "ok + entitled → true (authoritative)", cache: null, fetch: { status: "ok", value: ent(true) }, want: true },
    { name: "ok + free → false (downgrade even with entitled cache)", cache: ent(true), fetch: { status: "ok", value: ent(false) }, want: false },
    { name: "unauth → false", cache: ent(true), fetch: { status: "unauth" }, want: false },
    { name: "error + fresh cache → cache value", cache: ent(true, 3 * 60 * 60 * 1000), fetch: { status: "error" }, want: true },
    { name: "error + stale cache (>30d) → false", cache: ent(true, 31 * 24 * 60 * 60 * 1000), fetch: { status: "error" }, want: false },
    { name: "error + future-timestamp cache → false", cache: { agentEntitled: true, fetchedAt: new Date(NOW + 3_600_000).toISOString() }, fetch: { status: "error" }, want: false },
    { name: "error + no cache → false", cache: null, fetch: { status: "error" }, want: false },
    { name: "error + fresh cache that is free → false", cache: ent(false, 60_000), fetch: { status: "error" }, want: false },
  ];
  test.each(cases)("$name", ({ cache, fetch, want }) => {
    expect(resolveEntitlement({ cfg: CFG, now: NOW, cache, fetchResult: fetch })).toBe(want);
  });
});

describe("shouldRefetch", () => {
  test("no cache → true", () => {
    expect(shouldRefetch(null, NOW, CFG)).toBe(true);
  });
  test("fresh cache (< check interval) → false", () => {
    expect(shouldRefetch(ent(true, 60 * 60 * 1000), NOW, CFG)).toBe(false);
  });
  test("cache older than check interval → true", () => {
    expect(shouldRefetch(ent(true, 13 * 60 * 60 * 1000), NOW, CFG)).toBe(true);
  });
  test("future timestamp → true", () => {
    expect(shouldRefetch({ agentEntitled: true, fetchedAt: new Date(NOW + 3_600_000).toISOString() }, NOW, CFG)).toBe(true);
  });
  test("garbage timestamp → true", () => {
    expect(shouldRefetch({ agentEntitled: true, fetchedAt: "not-a-date" }, NOW, CFG)).toBe(true);
  });
});

describe("parseEntitlement", () => {
  test("valid → normalized", () => {
    expect(parseEntitlement({ agentEntitled: true, fetchedAt: "2026-07-15T00:00:00.000Z", plan: "pro" })).toEqual({
      agentEntitled: true,
      fetchedAt: "2026-07-15T00:00:00.000Z",
    });
  });
  test.each([null, undefined, 42, "x", {}, { agentEntitled: "yes", fetchedAt: "x" }, { agentEntitled: true }])(
    "garbage %s → null",
    (raw) => {
      expect(parseEntitlement(raw)).toBeNull();
    },
  );
});

describe("fetchEntitlement", () => {
  const okResp = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

  test("2xx JSON → ok", async () => {
    const fetchFn = vi.fn(async () => okResp({ agentEntitled: true, plan: "pro", fetchedAt: "2026-07-15T00:00:00.000Z" })) as unknown as typeof fetch;
    const r = await fetchEntitlement("https://api.rigel.run", "tok", fetchFn);
    expect(r).toEqual({ status: "ok", value: { agentEntitled: true, fetchedAt: "2026-07-15T00:00:00.000Z" } });
    expect(vi.mocked(fetchFn)).toHaveBeenCalledWith(
      "https://api.rigel.run/agent/entitlement",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer tok" }) }),
    );
  });
  test("trailing slash in endpoint is normalized", async () => {
    const fetchFn = vi.fn(async () => okResp({ agentEntitled: false, fetchedAt: "2026-07-15T00:00:00.000Z" })) as unknown as typeof fetch;
    await fetchEntitlement("https://api.rigel.run/", "tok", fetchFn);
    expect(vi.mocked(fetchFn).mock.calls[0]![0]).toBe("https://api.rigel.run/agent/entitlement");
  });
  test.each([401, 403])("%s → unauth", async (status) => {
    const fetchFn = vi.fn(async () => okResp({}, status)) as unknown as typeof fetch;
    expect(await fetchEntitlement("https://api.rigel.run", "tok", fetchFn)).toEqual({ status: "unauth" });
  });
  test("500 → error", async () => {
    const fetchFn = vi.fn(async () => okResp({}, 500)) as unknown as typeof fetch;
    expect(await fetchEntitlement("https://api.rigel.run", "tok", fetchFn)).toEqual({ status: "error" });
  });
  test("network throw → error", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await fetchEntitlement("https://api.rigel.run", "tok", fetchFn)).toEqual({ status: "error" });
  });
  test("malformed JSON body → error", async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true, json: async () => { throw new Error("bad json"); } })) as unknown as typeof fetch;
    expect(await fetchEntitlement("https://api.rigel.run", "tok", fetchFn)).toEqual({ status: "error" });
  });
  test("2xx but missing fields → error", async () => {
    const fetchFn = vi.fn(async () => okResp({ plan: "pro" })) as unknown as typeof fetch;
    expect(await fetchEntitlement("https://api.rigel.run", "tok", fetchFn)).toEqual({ status: "error" });
  });
});

describe("readEntitlementCache / writeEntitlementCache", () => {
  const stateCm = (data: Record<string, unknown>) => ({ stdout: JSON.stringify({ data: { "state.json": JSON.stringify(data) } }), stderr: "", code: 0 });

  test("read returns the cached entitlement stored in state", async () => {
    vi.mocked(kubectl).mockResolvedValue(stateCm({ updatedAt: "", audit: [], queue: [], report: "", entitlement: ent(true) }) as never);
    expect(await readEntitlementCache(CFG)).toEqual(ent(true));
  });
  test("read returns null on garbage entitlement", async () => {
    vi.mocked(kubectl).mockResolvedValue(stateCm({ updatedAt: "", audit: [], queue: [], report: "", entitlement: { nope: 1 } }) as never);
    expect(await readEntitlementCache(CFG)).toBeNull();
  });
  test("read returns null when absent", async () => {
    vi.mocked(kubectl).mockResolvedValue(stateCm({ updatedAt: "", audit: [], queue: [], report: "" }) as never);
    expect(await readEntitlementCache(CFG)).toBeNull();
  });

  test("write persists entitlement WITHOUT clobbering other state keys", async () => {
    let applied: string | undefined;
    vi.mocked(kubectl).mockImplementation(async (args: string[], stdin?: string) => {
      if (args[0] === "get") return stateCm({ updatedAt: "t0", audit: [{ at: "x" }], queue: [], report: "hello" }) as never;
      if (args[0] === "apply") { applied = stdin; return { stdout: "", stderr: "", code: 0 } as never; }
      return { stdout: "", stderr: "", code: 1 } as never;
    });
    await writeEntitlementCache(CFG, ent(true));
    const parsed = JSON.parse(applied ?? "{}") as { data?: Record<string, string> };
    const written = JSON.parse(parsed.data!["state.json"]!) as Record<string, unknown>;
    expect(written.entitlement).toEqual(ent(true));
    expect(written.report).toBe("hello");
    expect(written.audit).toEqual([{ at: "x" }]);
  });
});

describe("determineEntitlement", () => {
  const stateCm = () => ({ stdout: JSON.stringify({ data: { "state.json": JSON.stringify({ updatedAt: "", audit: [], queue: [], report: "" }) } }), stderr: "", code: 0 });

  test("empty token → false, no fetch attempted", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const entitled = await determineEntitlement({ cfg: { ...CFG, agentToken: "" } as Config, now: NOW, cache: null, fetchFn });
    expect(entitled).toBe(false);
    expect(vi.mocked(fetchFn)).not.toHaveBeenCalled();
  });

  test("refetch + ok entitled → true and the cache is persisted", async () => {
    vi.mocked(kubectl).mockResolvedValue(stateCm() as never);
    const value = { agentEntitled: true, fetchedAt: new Date(NOW).toISOString() };
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true, json: async () => value })) as unknown as typeof fetch;
    const entitled = await determineEntitlement({ cfg: CFG, now: NOW, cache: null, fetchFn });
    expect(entitled).toBe(true);
    // Persisted via a state apply.
    expect(vi.mocked(kubectl).mock.calls.some((c) => c[0]?.[0] === "apply")).toBe(true);
  });

  test("refetch + error, fresh cache → holds last-known-good (no persist)", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const entitled = await determineEntitlement({ cfg: CFG, now: NOW, cache: ent(true, 13 * 60 * 60 * 1000), fetchFn });
    expect(entitled).toBe(true);
    expect(vi.mocked(kubectl).mock.calls.some((c) => c[0]?.[0] === "apply")).toBe(false);
  });

  test("fresh cache (no refetch) → cache value, no fetch", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const entitled = await determineEntitlement({ cfg: CFG, now: NOW, cache: ent(false, 60_000), fetchFn });
    expect(entitled).toBe(false);
    expect(vi.mocked(fetchFn)).not.toHaveBeenCalled();
  });

  test("a write failure never throws out of the decision", async () => {
    vi.mocked(kubectl).mockRejectedValue(new Error("apply failed") as never);
    const value = { agentEntitled: true, fetchedAt: new Date(NOW).toISOString() };
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true, json: async () => value })) as unknown as typeof fetch;
    await expect(determineEntitlement({ cfg: CFG, now: NOW, cache: null, fetchFn })).resolves.toBe(true);
  });
});
