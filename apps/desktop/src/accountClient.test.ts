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

test("requestCode POSTs the email and returns the status", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return jsonResponse({ ok: true }); }) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  const r = await client.requestCode("jane@acme.com");
  expect(r).toEqual({ ok: true, status: 200 });
  expect(calls[0].url).toBe(`${ENDPOINT}/auth/request`);
  expect(JSON.parse(calls[0].init!.body as string)).toEqual({ email: "jane@acme.com" });
});

test("requestCode surfaces a non-2xx status without throwing", async () => {
  const fetchFn = (async () => jsonResponse({ error: "rate limited" }, 429)) as typeof fetch;
  const client = createAccountClient({ store: memStore(), fetchFn, endpoint: ENDPOINT });
  expect(await client.requestCode("a@b.co")).toEqual({ ok: false, status: 429 });
});

test("verifyCode stores the token and returns the account on 200", async () => {
  const store = memStore();
  const fetchFn = (async () => jsonResponse({ token: "tok-xyz", account: { id: "1", email: "a@b.co", name: "Jane" } })) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  const r = await client.verifyCode("a@b.co", "123456");
  expect(r).toEqual({ ok: true, account: { id: "1", email: "a@b.co", name: "Jane" } });
  expect(store.value).toBe("tok-xyz");
});

test("verifyCode returns the status and stores no token on failure", async () => {
  const store = memStore();
  const fetchFn = (async () => jsonResponse({ error: "invalid code" }, 401)) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.verifyCode("a@b.co", "000000")).toEqual({ ok: false, status: 401 });
  expect(store.value).toBeNull();
});

test("verifyLink stores the token and returns the account on 200", async () => {
  const store = memStore();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    expect(url).toBe(`${ENDPOINT}/auth/verify-link`);
    return jsonResponse({ token: "tok-link", account: { id: "1", email: "a@b.co", name: "Jane" } });
  }) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  const r = await client.verifyLink("linktoken123");
  expect(r).toEqual({ ok: true, account: { id: "1", email: "a@b.co", name: "Jane" } });
  expect(store.value).toBe("tok-link");
  expect(JSON.parse(calls[0].init!.body as string)).toEqual({ token: "linktoken123" });
});

test("verifyLink returns the status and stores no token on failure", async () => {
  const store = memStore();
  const fetchFn = (async () => jsonResponse({ error: "invalid or expired link" }, 401)) as typeof fetch;
  const client = createAccountClient({ store, fetchFn, endpoint: ENDPOINT });
  expect(await client.verifyLink("nope")).toEqual({ ok: false, status: 401 });
  expect(store.value).toBeNull();
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
