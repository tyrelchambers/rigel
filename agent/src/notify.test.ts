// agent/src/notify.test.ts
import { afterEach, describe, expect, test, vi } from "vitest";
import { notifyMatrix, receiveMatrix } from "./notify.js";

afterEach(() => vi.unstubAllGlobals());

describe("notifyMatrix", () => {
  test("PUTs an m.text message with a bearer token to the room send endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));
    await notifyMatrix("https://hs.example/", "tok", "!room:hs", "hello");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain("https://hs.example/_matrix/client/v3/rooms/");
    expect(call.url).toContain("/send/m.room.message/");
    expect(call.init.method).toBe("PUT");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(call.init.body))).toEqual({ msgtype: "m.text", body: "hello" });
  });

  test("chunks a long message into multiple PUTs", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyMatrix("https://hs", "tok", "!r", "x".repeat(3000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  test("never throws when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(notifyMatrix("https://hs", "tok", "!r", "hi")).resolves.toBeUndefined();
  });
});

describe("receiveMatrix", () => {
  test("GETs /sync with the since cursor and returns the json", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ next_batch: "s2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await receiveMatrix("https://hs/", "tok", "s1");
    expect(out).toEqual({ next_batch: "s2" });
    const url = String((fetchMock.mock.calls[0]! as unknown[])[0]);
    expect(url).toContain("/_matrix/client/v3/sync?");
    expect(url).toContain("since=s1");
  });

  test("throws on a non-2xx sync so the caller logs and skips", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(receiveMatrix("https://hs", "tok")).rejects.toThrow(/401/);
  });
});
