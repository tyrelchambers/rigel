import { test, expect } from "vitest";
import { createKitNotifier } from "./kit";
import type { Signup } from "./validate";

const signup: Signup = {
  installId: "11111111-1111-1111-1111-111111111111",
  name: "Ada Lovelace",
  email: "ada@example.com",
  appVersion: "waitlist",
  platform: "web",
};

/** A fetch stand-in that records calls and returns a fixed ok/status. */
function fakeFetch(calls: { url: string; init: RequestInit }[], ok = true) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok, status: ok ? 200 : 500 } as Response;
  }) as unknown as typeof fetch;
}

test("no apiKey: notifier is a no-op (makes no calls)", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const notify = createKitNotifier({ apiKey: "", tagId: 42, fetchImpl: fakeFetch(calls) });
  await notify(signup);
  expect(calls).toEqual([]);
});

test("upserts the subscriber, then applies the tag", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const notify = createKitNotifier({ apiKey: "k", tagId: 42, baseUrl: "https://api.kit.com/v4", fetchImpl: fakeFetch(calls) });
  await notify(signup);

  expect(calls).toHaveLength(2);
  expect(calls[0].url).toBe("https://api.kit.com/v4/subscribers");
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ email_address: "ada@example.com", first_name: "Ada Lovelace" });
  expect((calls[0].init.headers as Record<string, string>)["X-Kit-Api-Key"]).toBe("k");

  expect(calls[1].url).toBe("https://api.kit.com/v4/tags/42/subscribers");
  expect(JSON.parse(calls[1].init.body as string)).toEqual({ email_address: "ada@example.com" });
});

test("no tagId: only upserts the subscriber", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const notify = createKitNotifier({ apiKey: "k", tagId: null, fetchImpl: fakeFetch(calls) });
  await notify(signup);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain("/subscribers");
});

test("throws when the subscriber upsert fails (so the caller can log it)", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const notify = createKitNotifier({ apiKey: "k", tagId: 42, fetchImpl: fakeFetch(calls, false) });
  await expect(notify(signup)).rejects.toThrow(/kit subscribers 500/);
});
