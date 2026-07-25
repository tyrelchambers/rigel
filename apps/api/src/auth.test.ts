import { test, expect } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { registerAuthRoutes } from "./auth";
import type { AuthDb, Account, OrgMembership } from "./authDb";
import { displayCodeFor } from "./displayCode";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** In-memory AuthDb honoring the same contract the SQL implements. */
function fakeDb() {
  const codes: { email: string; codeHash: string; linkTokenHash: string; attempts: number; consumed: boolean }[] = [];
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
    async insertCode(email, codeHash, linkTokenHash) { codes.push({ email, codeHash, linkTokenHash, attempts: 0, consumed: false }); },
    async invalidateCodes(email) { codes.forEach((c) => { if (c.email === email) c.consumed = true; }); },
    async claimAttempt(email) {
      const c = [...codes].reverse().find((c) => c.email === email && !c.consumed && c.attempts < 5);
      if (!c) return null;
      c.attempts++;
      return { codeHash: c.codeHash };
    },
    async consumeCode(email) {
      const c = [...codes].reverse().find((c) => c.email === email && !c.consumed);
      if (!c) return false;
      c.consumed = true;
      return true;
    },
    async consumeLinkToken(linkTokenHash) {
      const c = [...codes].reverse().find((c) => c.linkTokenHash === linkTokenHash && !c.consumed);
      if (!c) return null;
      c.consumed = true;
      return { email: c.email };
    },
    async cleanupExpiredCodes() {},
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
  return { db, codes, pendings };
}

function make(over: { sendLink?: (e: string, url: string) => Promise<void>; allow?: () => boolean } = {}) {
  const { db, codes, pendings } = fakeDb();
  const sent: { email: string; confirmUrl: string }[] = [];
  const sendLink = over.sendLink ?? (async (email, confirmUrl) => { sent.push({ email, confirmUrl }); });
  const allow = over.allow ?? (() => true);
  const app = new Hono();
  registerAuthRoutes(app, {
    db,
    sendLink,
    allowRequest: allow,
    allowVerify: allow,
    allowPoll: allow,
    publicUrl: "https://api.example.test",
  });
  const seed =(email: string, code: string, linkToken: string) => db.insertCode(email, sha(code), sha(linkToken), 600);
  return { app, db, codes, pendings, sent, seed };
}

const json = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function signIn(app: Hono, seed: (e: string, c: string, l: string) => Promise<void>, email = "a@b.co") {
  await seed(email, "123456", "link-1");
  const res = await json(app, "/auth/verify", { email, code: "123456" });
  return (await res.json()) as { token: string };
}

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
    allowPoll: () => true, publicUrl: "https://api.example.test",
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
    allowVerify: () => true, allowPoll: () => true, publicUrl: "https://api.example.test",
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
    allowPoll: () => true, publicUrl: "https://api.example.test",
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

test("verify with the right code → token + account", async () => {
  const { app, seed } = make();
  await seed("a@b.co", "123456", "link-1");
  const res = await json(app, "/auth/verify", { email: "a@b.co", code: "123456" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; account: { id: string; email: string; name: string } };
  expect(body.token.length).toBeGreaterThan(20);
  expect(body.account).toEqual({ id: "acc-1", email: "a@b.co", name: "Jane" });
});

test("verify with the wrong code → 401", async () => {
  const { app, seed } = make();
  await seed("a@b.co", "123456", "link-1");
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: "000000" })).status).toBe(401);
});

test("verify is single-use", async () => {
  const { app, seed } = make();
  await seed("a@b.co", "123456", "link-1");
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: "123456" })).status).toBe(200);
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: "123456" })).status).toBe(401);
});

test("verify caps at 5 attempts then locks the code out", async () => {
  const { app, seed } = make();
  await seed("a@b.co", "123456", "link-1");
  for (let i = 0; i < 5; i++) await json(app, "/auth/verify", { email: "a@b.co", code: "000000" });
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: "123456" })).status).toBe(401);
});

test("me returns the account for a valid bearer, 401 after logout", async () => {
  const { app, seed } = make();
  const body = await signIn(app, seed);
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
  const { app, seed } = make();
  const body = await signIn(app, seed);
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

test("verify-link with the emailed token → bearer + account", async () => {
  const { app, seed } = make();
  await seed("a@b.co", "123456", "link-1");
  const res = await json(app, "/auth/verify-link", { token: "link-1" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; account: { id: string; email: string; name: string | null } };
  expect(body.token.length).toBeGreaterThan(20);
  expect(body.account.email).toBe("a@b.co");
});

test("verify-link with an unknown token → 401", async () => {
  const { app } = make();
  expect((await json(app, "/auth/verify-link", { token: "nope" })).status).toBe(401);
});

test("using the code first invalidates the magic link (shared row)", async () => {
  const { app, seed } = make();
  await seed("a@b.co", "123456", "link-1");
  await json(app, "/auth/verify", { email: "a@b.co", code: "123456" });   // consume via code
  expect((await json(app, "/auth/verify-link", { token: "link-1" })).status).toBe(401);   // link now dead
});

test("using the magic link first invalidates the code (shared row)", async () => {
  const { app, seed } = make();
  await seed("a@b.co", "123456", "link-1");
  expect((await json(app, "/auth/verify-link", { token: "link-1" })).status).toBe(200);         // link consumed
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: "123456" })).status).toBe(401); // code now dead
});

test("verify-link is rate-limited → 429", async () => {
  const { app } = make({ allow: () => false });
  expect((await json(app, "/auth/verify-link", { token: "anything" })).status).toBe(429);
});
