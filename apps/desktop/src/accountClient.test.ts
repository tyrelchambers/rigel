import { test, expect } from "vitest";
import { createAccountClient, type MePayload } from "./accountClient";

/** Minimal in-memory store matching the AccountStore surface the client uses. */
function memStore(initial: string | null = null) {
  let tok = initial;
  return {
    available: true,
    getToken: () => tok,
    setToken: (t: string) => { tok = t; },
    clear: () => { tok = null; },
    get value() { return tok; },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ENDPOINT = "https://api.test";

test("startSignIn POSTs the email and returns the poll token plus display code", async () => {
  const store = memStore();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse({ pollToken: "poll-abc", displayCode: "WX7Q" });
  }) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  const r = await client.startSignIn("jane@acme.com");
  expect(r).toEqual({ ok: true, status: 200, pollToken: "poll-abc", displayCode: "WX7Q" });
  expect(calls[0].url).toBe(`${ENDPOINT}/auth/request`);
  expect(JSON.parse(calls[0].init!.body as string)).toEqual({ email: "jane@acme.com" });
  expect(store.value).toBeNull(); // no bearer token until the sign-in is confirmed
});

test("startSignIn surfaces a non-2xx status without throwing", async () => {
  const fetchFn = (async () => jsonResponse({ error: "rate limited" }, 429)) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  expect(await client.startSignIn("a@b.co")).toEqual({ ok: false, status: 429 });
});

test("startSignIn fails when the response omits displayCode (the CSRF guard must be armed)", async () => {
  const fetchFn = (async () => jsonResponse({ pollToken: "poll-abc" })) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  expect(await client.startSignIn("a@b.co")).toEqual({ ok: false, status: 200 });
});

test("startSignIn fails when the response omits pollToken", async () => {
  const fetchFn = (async () => jsonResponse({ displayCode: "WX7Q" })) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  expect(await client.startSignIn("a@b.co")).toEqual({ ok: false, status: 200 });
});

test("poll stores the bearer token and returns the account on confirmation", async () => {
  const store = memStore();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse({ status: "confirmed", token: "tok-xyz", account: { id: "1", email: "a@b.co", name: "Jane" } });
  }) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  const r = await client.poll("poll-abc");
  expect(r).toEqual({ status: "confirmed", account: { id: "1", email: "a@b.co", name: "Jane" } });
  expect(store.value).toBe("tok-xyz");
  expect(calls[0].url).toBe(`${ENDPOINT}/auth/poll`);
  expect(JSON.parse(calls[0].init!.body as string)).toEqual({ pollToken: "poll-abc" });
});

test("poll reports pending and stores nothing while the user has not confirmed", async () => {
  const store = memStore();
  const fetchFn = (async () => jsonResponse({ status: "pending" })) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.poll("poll-abc")).toEqual({ status: "pending" });
  expect(store.value).toBeNull();
});

test("poll reports expired on 404", async () => {
  const store = memStore();
  const fetchFn = (async () => jsonResponse({ status: "expired" }, 404)) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.poll("poll-abc")).toEqual({ status: "expired" });
  expect(store.value).toBeNull();
});

test("poll reports pending on a server error, so a blip never ends a live sign-in", async () => {
  const fetchFn = (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  expect(await client.poll("poll-abc")).toEqual({ status: "pending" });
});

test("poll reports pending when fetch throws", async () => {
  const fetchFn = (async () => { throw new Error("offline"); }) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  expect(await client.poll("poll-abc")).toEqual({ status: "pending" });
});

test("me sends the bearer and returns the full payload", async () => {
  const calls: RequestInit[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => { calls.push(init!); return jsonResponse({ account: { id: "1", email: "a@b.co", name: "Jane" } }); }) as typeof fetch;
  const client = createAccountClient({ store: memStore("tok-1"), fetchFn, endpoint: ENDPOINT });
  const me = (await client.me()) as MePayload;
  expect(me.account).toEqual({ id: "1", email: "a@b.co", name: "Jane" });
  expect((calls[0].headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
});

test("me returns null and clears the token on 401", async () => {
  const store = memStore("stale");
  const fetchFn = (async () => jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.me()).toBeNull();
  expect(store.value).toBeNull();
});

test("me returns null without calling fetch when there is no token", async () => {
  let called = false;
  const fetchFn = (async () => { called = true; return jsonResponse({}); }) as typeof fetch;
  const client = createAccountClient({ store: memStore(null), fetchFn, endpoint: ENDPOINT });
  expect(await client.me()).toBeNull();
  expect(called).toBe(false);
});

test("me returns null on a network error (keeps the token for retry)", async () => {
  const store = memStore("tok-1");
  const fetchFn = (async () => { throw new Error("offline"); }) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.me()).toBeNull();
  expect(store.value).toBe("tok-1"); // NOT cleared on a network failure
});

test("signOut revokes then clears the token, even if the request fails", async () => {
  const store = memStore("tok-1");
  const fetchFn = (async () => { throw new Error("offline"); }) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  await client.signOut();
  expect(store.value).toBeNull();
});

test("signOutEverywhere revokes every device and clears the local token", async () => {
  const store = memStore("tok-1");
  const calls: { url: string; auth?: string }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return jsonResponse({ ok: true, revoked: 3 });
  }) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });

  await client.signOutEverywhere();

  expect(calls[0].url).toBe(`${ENDPOINT}/auth/logout-all`);
  expect(calls[0].auth).toBe("Bearer tok-1");
  expect(store.value).toBeNull();
});

// signOut swallows a failed revoke because the local token is going away either
// way. Here the server call IS the point: clearing locally while other devices
// stay signed in would tell the user something untrue.
test("signOutEverywhere surfaces a failure instead of clearing the token", async () => {
  const store = memStore("tok-1");
  const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });

  await expect(client.signOutEverywhere()).rejects.toThrow();
  expect(store.value).toBe("tok-1");
});
