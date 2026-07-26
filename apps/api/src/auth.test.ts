import { test, expect, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { registerAuthRoutes } from "./auth";
import type { AuthDb, Account, OrgMembership } from "./authDb";
import { displayCodeFor } from "./displayCode";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** In-memory AuthDb honoring the same contract the SQL implements. */
function fakeDb() {
  const pendings: {
    email: string; pollTokenHash: string; confirmTokenHash: string;
    confirmed: boolean; consumed: boolean; expired: boolean;
  }[] = [];
  const accounts = new Map<string, Account>();
  const tokens = new Map<string, string>(); // tokenHash -> accountId
  const revoked = new Set<string>();
  const personalOrgs = new Map<string, OrgMembership>();
  let seq = 0;
  const db: AuthDb = {
    async createPendingLogin({ email, pollTokenHash, confirmTokenHash }) {
      pendings.push({ email, pollTokenHash, confirmTokenHash, confirmed: false, consumed: false, expired: false });
    },
    async invalidatePendingLogins(email) {
      pendings.forEach((p) => { if (p.email === email) p.consumed = true; });
    },
    async confirmPendingLogin(confirmTokenHash) {
      const p = [...pendings].reverse().find(
        (p) => p.confirmTokenHash === confirmTokenHash && !p.confirmed && !p.consumed && !p.expired,
      );
      if (!p) return null;
      p.confirmed = true;
      return { email: p.email };
    },
    async pendingLoginByConfirmHash(confirmTokenHash) {
      const p = [...pendings].reverse().find(
        (p) => p.confirmTokenHash === confirmTokenHash && !p.confirmed && !p.consumed && !p.expired,
      );
      return p ? { email: p.email, pollTokenHash: p.pollTokenHash } : null;
    },
    async consumeConfirmedLogin(pollTokenHash) {
      const p = [...pendings].reverse().find(
        (p) => p.pollTokenHash === pollTokenHash && p.confirmed && !p.consumed && !p.expired,
      );
      if (!p) return null;
      p.consumed = true;
      return { email: p.email };
    },
    async pendingLoginActive(pollTokenHash) {
      return pendings.some((p) => p.pollTokenHash === pollTokenHash && !p.consumed && !p.expired);
    },
    async cleanupExpiredPendingLogins() {},
    async upsertAccount(email) {
      // Deliberately does NOT create a personal org here — models a "legacy"
      // account so the /me self-heal (lazy ensurePersonalOrg) is exercised.
      // The real backend's upsertAccount auto-provisioning is covered in authDb.test.ts.
      let a = accounts.get(email);
      if (!a) { a = { id: `acc-${++seq}`, email, name: "Jane" }; accounts.set(email, a); }
      return a;
    },
    async insertToken(tokenHash, accountId) { tokens.set(tokenHash, accountId); },
    async accountByToken(tokenHash) {
      if (revoked.has(tokenHash)) return null;
      const accId = tokens.get(tokenHash);
      if (!accId) return null;
      return [...accounts.values()].find((a) => a.id === accId) ?? null;
    },
    async touchToken() {},
    async revokeToken(tokenHash) { revoked.add(tokenHash); },
    async ensurePersonalOrg(accountId, name) {
      personalOrgs.set(accountId, { id: `org-${accountId}`, kind: "personal", name, role: "owner" });
    },
    async getOrgsForAccount(accountId) {
      const org = personalOrgs.get(accountId);
      return org ? [org] : [];
    },
    async billableOrgs() { return []; },
    async orgBilling() { return null; },
    async orgSeatCount() { return 0; },
    async setOrgStripeCustomer() {},
    async accountEmail() { return "a@b.co"; },
    async createAgentToken() {},
    async agentTokenByHash() { return null; },
    async orgStripeCustomer() { return null; },
  };
  return { db, pendings };
}

interface Overrides {
  sendLink?: (e: string, url: string) => Promise<void>;
  allow?: () => boolean;
  allowPoll?: (key: string) => boolean;
  allowPollIp?: (key: string) => boolean;
}

function make(over: Overrides = {}) {
  const { db, pendings } = fakeDb();
  const sent: { email: string; confirmUrl: string }[] = [];
  const sendLink = over.sendLink ?? (async (email, confirmUrl) => { sent.push({ email, confirmUrl }); });
  const allow = over.allow ?? (() => true);
  const app = new Hono();
  registerAuthRoutes(app, {
    db,
    sendLink,
    allowRequest: allow,
    allowVerify: allow,
    allowPoll: over.allowPoll ?? allow,
    allowPollIp: over.allowPollIp ?? allow,
    publicUrl: "https://api.example.test",
  });
  return { app, db, pendings, sent };
}

const json = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("POST /auth/request returns a poll token and emails a confirm link", async () => {
  const { db, pendings } = fakeDb();
  const sent: { email: string; confirmUrl: string }[] = [];
  const app = new Hono();
  registerAuthRoutes(app, {
    db,
    sendLink: async (email, confirmUrl) => { sent.push({ email, confirmUrl }); },
    allowRequest: () => true,
    allowVerify: () => true,
    allowPoll: () => true,
    allowPollIp: () => true,
    publicUrl: "https://api.example.test",
  });

  const res = await app.request("/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "Jane@Acme.com" }),
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { pollToken: string };
  expect(typeof body.pollToken).toBe("string");
  expect(body.pollToken.length).toBeGreaterThan(20);

  expect(sent).toHaveLength(1);
  expect(sent[0].email).toBe("jane@acme.com");
  expect(sent[0].confirmUrl).toMatch(/^https:\/\/api\.example\.test\/auth\/confirm\?t=[\w-]+$/);

  expect(pendings).toHaveLength(1);
  expect(pendings[0].email).toBe("jane@acme.com");
  expect(pendings[0].pollTokenHash).toBe(sha(body.pollToken));
  expect(pendings[0].confirmTokenHash).not.toBe(pendings[0].pollTokenHash);
});

test("POST /auth/request returns a display code derived from the poll token", async () => {
  const { db } = fakeDb();
  const app = new Hono();
  registerAuthRoutes(app, {
    db, sendLink: async () => {}, allowRequest: () => true, allowVerify: () => true,
    allowPoll: () => true, allowPollIp: () => true, publicUrl: "https://api.example.test",
  });
  const res = await app.request("/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "jane@acme.com" }),
  });
  const body = (await res.json()) as { pollToken: string; displayCode: string };
  expect(body.displayCode).toBe(displayCodeFor(sha(body.pollToken)));
  expect(body.displayCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

test("the display code is never emailed", async () => {
  const { db } = fakeDb();
  let sentUrl = "";
  const app = new Hono();
  registerAuthRoutes(app, {
    db, sendLink: async (_e, url) => { sentUrl = url; }, allowRequest: () => true,
    allowVerify: () => true, allowPoll: () => true, allowPollIp: () => true, publicUrl: "https://api.example.test",
  });
  const res = await app.request("/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "jane@acme.com" }),
  });
  const { displayCode } = (await res.json()) as { displayCode: string };
  expect(sentUrl).toMatch(/^https:\/\/api\.example\.test\/auth\/confirm\?t=[\w-]+$/);
  expect(sentUrl).not.toContain(displayCode);
});

test("POST /auth/request 502s and issues no poll token when the email fails", async () => {
  const { db, pendings } = fakeDb();
  const app = new Hono();
  registerAuthRoutes(app, {
    db,
    sendLink: async () => { throw new Error("resend down"); },
    allowRequest: () => true,
    allowVerify: () => true,
    allowPoll: () => true,
    allowPollIp: () => true,
    publicUrl: "https://api.example.test",
  });

  const res = await app.request("/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "jane@acme.com" }),
  });

  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "could not send link" });
  expect(pendings.every((p) => p.consumed)).toBe(true);
});

test("POST /auth/request invalidates any earlier pending login for the same email", async () => {
  const { db, pendings } = fakeDb();
  const app = new Hono();
  registerAuthRoutes(app, {
    db, sendLink: async () => {}, allowRequest: () => true, allowVerify: () => true,
    allowPoll: () => true, allowPollIp: () => true, publicUrl: "https://api.example.test",
  });
  const send = () => app.request("/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "jane@acme.com" }),
  });
  await send();
  await send();
  expect(pendings).toHaveLength(2);
  expect(pendings[0].consumed).toBe(true);
  expect(pendings[1].consumed).toBe(false);
});

test("request with a bad email → 400, nothing sent", async () => {
  const { app, sent } = make();
  expect((await json(app, "/auth/request", { email: "nope" })).status).toBe(400);
  expect(sent.length).toBe(0);
});

test("the code and magic-link routes are gone", async () => {
  const { app } = await appWithPendingLogin();
  const verify = await app.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "jane@acme.com", code: "123456" }),
  });
  expect(verify.status).toBe(404);

  const link = await app.request("/auth/verify-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "abc" }),
  });
  expect(link.status).toBe(404);
});

test("me returns the account for a valid bearer, 401 after logout", async () => {
  const { app, sent } = make();
  const body = await signInViaPoll(app, sent, "a@b.co");
  const auth = { authorization: `Bearer ${body.token}` };
  const meRes = await app.request("/me", { headers: auth });
  expect(meRes.status).toBe(200);
  const me = (await meRes.json()) as { account: { id: string; email: string; name: string } };
  expect(me.account).toEqual({ id: "acc-1", email: "a@b.co", name: "Jane" });
  expect((await app.request("/auth/logout", { method: "POST", headers: auth })).status).toBe(200);
  expect((await app.request("/me", { headers: auth })).status).toBe(401);
});

test("me self-heals a personal org for an account that has none, and returns it", async () => {
  // The fake upsertAccount creates NO org (legacy account); /me must lazily
  // create the personal org so every signed-in account always has one.
  const { app, sent } = make();
  const body = await signInViaPoll(app, sent, "a@b.co");
  const me = await (await app.request("/me", { headers: { authorization: `Bearer ${body.token}` } })).json() as { account: { email: string }; orgs: Array<{ kind: string; role: string }> };
  expect(me.account.email).toBe("a@b.co");
  expect(me.orgs).toHaveLength(1);
  expect(me.orgs[0]).toMatchObject({ kind: "personal", role: "owner" });
});

test("me without a token → 401", async () => {
  const { app } = make();
  expect((await app.request("/me")).status).toBe(401);
});

test("request rate-limited → 429", async () => {
  const { app, sent } = make({ allow: () => false });
  expect((await json(app, "/auth/request", { email: "a@b.co" })).status).toBe(429);
  expect(sent.length).toBe(0);
});

const form = (app: Hono, path: string, fields: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

/** A live pending login, plus the confirm token as it reaches the human's inbox. */
async function appWithPendingLogin(over: Overrides = {}, email = "jane@acme.com") {
  const { app, db, pendings, sent } = make(over);
  const res = await json(app, "/auth/request", { email });
  const { pollToken, displayCode } = (await res.json()) as { pollToken: string; displayCode: string };
  const confirmToken = new URL(sent[0].confirmUrl).searchParams.get("t") ?? "";
  expect(confirmToken.length).toBeGreaterThan(20);
  return { app, db, pendings, pollToken, confirmToken, displayCode };
}

test("GET /auth/confirm shows the code and leaves the row unconfirmed", async () => {
  const { app, pendings, confirmToken, displayCode } = await appWithPendingLogin();
  const res = await app.request(`/auth/confirm?t=${confirmToken}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(displayCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(html).toContain(displayCode);
  expect(html).toContain("jane@acme.com");
  expect(pendings[0].confirmed).toBe(false);
  expect(pendings[0].consumed).toBe(false);
  expect((await form(app, "/auth/confirm", { t: confirmToken, action: "confirm" })).status).toBe(200);
});

test("the code GET renders is displayCodeFor the row's poll token hash", async () => {
  const { app, pendings, confirmToken } = await appWithPendingLogin();
  const html = await (await app.request(`/auth/confirm?t=${confirmToken}`)).text();
  const expected = displayCodeFor(pendings[0].pollTokenHash);
  expect(expected).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(html).toContain(`>${expected}<`);
});

test("POST /auth/confirm confirms the row once, and a replay is rejected", async () => {
  const { app, pendings, confirmToken } = await appWithPendingLogin();
  const first = await form(app, "/auth/confirm", { t: confirmToken, action: "confirm" });
  expect(first.status).toBe(200);
  expect(await first.text()).toContain("jane@acme.com");
  expect(pendings[0].confirmed).toBe(true);
  expect((await form(app, "/auth/confirm", { t: confirmToken, action: "confirm" })).status).toBe(400);
});

test("denying kills the row so a later confirm cannot succeed", async () => {
  const { app, pendings, confirmToken } = await appWithPendingLogin();
  expect((await form(app, "/auth/confirm", { t: confirmToken, action: "deny" })).status).toBe(200);
  expect(pendings[0].consumed).toBe(true);
  expect(pendings[0].confirmed).toBe(false);
  expect((await form(app, "/auth/confirm", { t: confirmToken, action: "confirm" })).status).toBe(400);
});

test("POST /auth/confirm with a bogus token renders the invalid page", async () => {
  const { app, pendings } = await appWithPendingLogin();
  const res = await form(app, "/auth/confirm", { t: "not-a-token", action: "confirm" });
  expect(res.status).toBe(400);
  expect((await res.text()).toLowerCase()).toContain("expired");
  expect(pendings[0].confirmed).toBe(false);
});

test("GET /auth/confirm with a bogus token renders the invalid page", async () => {
  const { app } = await appWithPendingLogin();
  const res = await app.request("/auth/confirm?t=not-a-token");
  expect(res.status).toBe(400);
  expect((await res.text()).toLowerCase()).toContain("expired");
  expect((await app.request("/auth/confirm")).status).toBe(400);
});

test("POST /auth/poll is pending until the human confirms", async () => {
  const { app, pollToken } = await appWithPendingLogin();
  const res = await json(app, "/auth/poll", { pollToken });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "pending" });
});

test("POST /auth/poll mints a bearer token once the login is confirmed", async () => {
  const { app, pollToken, confirmToken } = await appWithPendingLogin();
  expect((await form(app, "/auth/confirm", { t: confirmToken, action: "confirm" })).status).toBe(200);
  const res = await json(app, "/auth/poll", { pollToken });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; token: string; account: { id: string; email: string; name: string | null } };
  expect(body.status).toBe("confirmed");
  expect(typeof body.token).toBe("string");
  expect(body.token.length).toBeGreaterThan(20);
  expect(body.account.email).toBe("jane@acme.com");
});

test("the token POST /auth/poll mints authenticates /me", async () => {
  const { app, pollToken, confirmToken } = await appWithPendingLogin();
  await form(app, "/auth/confirm", { t: confirmToken, action: "confirm" });
  const { token } = (await (await json(app, "/auth/poll", { pollToken })).json()) as { token: string };
  const meRes = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });
  expect(meRes.status).toBe(200);
  const me = (await meRes.json()) as { account: { email: string } };
  expect(me.account.email).toBe("jane@acme.com");
});

test("a replayed POST /auth/poll is expired and mints nothing", async () => {
  const { app, pollToken, confirmToken } = await appWithPendingLogin();
  await form(app, "/auth/confirm", { t: confirmToken, action: "confirm" });
  expect((await json(app, "/auth/poll", { pollToken })).status).toBe(200);
  const replay = await json(app, "/auth/poll", { pollToken });
  expect(replay.status).toBe(404);
  expect(await replay.json()).toEqual({ status: "expired" });
});

test("POST /auth/poll with a token that was never issued reports expired, not pending", async () => {
  const { app } = make();
  const res = await json(app, "/auth/poll", { pollToken: "never-issued" });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ status: "expired" });
});

test("POST /auth/poll rate-limited by poll token → 429", async () => {
  const { app } = make({ allowPoll: () => false });
  const res = await json(app, "/auth/poll", { pollToken: "anything" });
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: "rate limited" });
});

test("POST /auth/poll rate-limited by IP → 429", async () => {
  const { app } = make({ allowPollIp: () => false });
  const res = await json(app, "/auth/poll", { pollToken: "anything" });
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: "rate limited" });
});

test("POST /auth/poll gates on IP before it touches the token-keyed limiter", async () => {
  const calls: string[] = [];
  const { app } = make({
    allowPoll: (key) => { calls.push(`token ${key}`); return true; },
    allowPollIp: (key) => { calls.push(`ip ${key}`); return true; },
  });
  await json(app, "/auth/poll", { pollToken: "anything" }, { "x-forwarded-for": "9.9.9.9" });
  expect(calls).toEqual([`ip auth:poll:ip:9.9.9.9`, `token auth:poll:${sha("anything")}`]);
});

test("a flooding IP never reaches the token-keyed limiter, so its map cannot grow", async () => {
  const tokenKeys: string[] = [];
  const { app } = make({
    allowPoll: (key) => { tokenKeys.push(key); return true; },
    allowPollIp: () => false,
  });
  for (const t of ["rand-1", "rand-2", "rand-3"]) {
    expect((await json(app, "/auth/poll", { pollToken: t })).status).toBe(429);
  }
  expect(tokenKeys).toEqual([]);
});

const tokenFrom = (url: string) => new URL(url).searchParams.get("t") ?? "";

const me = (app: Hono, token: string) => app.request("/me", { headers: { authorization: `Bearer ${token}` } });

/** Drives the whole device flow once, returning the minted bearer. */
async function signInViaPoll(app: Hono, sent: { confirmUrl: string }[], email = "jane@acme.com") {
  const { pollToken } = (await (await json(app, "/auth/request", { email })).json()) as { pollToken: string };
  const confirmToken = tokenFrom(sent[sent.length - 1].confirmUrl);
  expect((await form(app, "/auth/confirm", { t: confirmToken, action: "confirm" })).status).toBe(200);
  const body = (await (await json(app, "/auth/poll", { pollToken })).json()) as { token: string };
  return { token: body.token };
}

