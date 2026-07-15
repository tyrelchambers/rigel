import { test, expect, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { registerAuthRoutes } from "./auth";
import type { AuthDb, Account, OrgMembership } from "./authDb";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** In-memory AuthDb honoring the same contract the SQL implements. */
function fakeDb() {
  const codes: { email: string; codeHash: string; linkTokenHash: string; attempts: number; consumed: boolean }[] = [];
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
  return { db, codes };
}

function make(over: { sendCode?: (e: string, c: string, m: string) => Promise<void>; allow?: () => boolean } = {}) {
  const { db, codes } = fakeDb();
  const sent: { email: string; code: string; magicUrl: string }[] = [];
  const sendCode = over.sendCode ?? (async (email, code, magicUrl) => { sent.push({ email, code, magicUrl }); });
  const allow = over.allow ?? (() => true);
  const app = new Hono();
  registerAuthRoutes(app, { db, sendCode, allowRequest: allow, allowVerify: allow });
  return { app, db, codes, sent };
}

const json = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("request → sends a 6-digit code and returns ok", async () => {
  const { app, sent } = make();
  const res = await json(app, "/auth/request", { email: "Jane@Acme.com" });
  expect(res.status).toBe(200);
  expect(sent.length).toBe(1);
  expect(sent[0].email).toBe("jane@acme.com");
  expect(sent[0].code).toMatch(/^[0-9]{6}$/);
});

test("request with a bad email → 400, nothing sent", async () => {
  const { app, sent } = make();
  expect((await json(app, "/auth/request", { email: "nope" })).status).toBe(400);
  expect(sent.length).toBe(0);
});

test("request returns 502 when Resend fails (not hidden)", async () => {
  const { app } = make({ sendCode: async () => { throw new Error("resend down"); } });
  expect((await json(app, "/auth/request", { email: "a@b.co" })).status).toBe(502);
});

test("verify with the right code → token + account", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const res = await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; account: { id: string; email: string; name: string } };
  expect(body.token.length).toBeGreaterThan(20);
  expect(body.account).toEqual({ id: "acc-1", email: "a@b.co", name: "Jane" });
});

test("verify with the wrong code → 401", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const wrong = sent[0].code === "000000" ? "111111" : "000000";
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: wrong })).status).toBe(401);
});

test("verify is single-use", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).status).toBe(200);
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).status).toBe(401);
});

test("verify caps at 5 attempts then locks the code out", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  for (let i = 0; i < 5; i++) await json(app, "/auth/verify", { email: "a@b.co", code: "000000" });
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).status).toBe(401);
});

test("me returns the account for a valid bearer, 401 after logout", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const body = (await (await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).json()) as { token: string };
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
  await json(app, "/auth/request", { email: "a@b.co" });
  const body = (await (await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).json()) as { token: string };
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

test("request emails a code AND a rigel:// magic link", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  expect(sent[0].code).toMatch(/^[0-9]{6}$/);
  expect(sent[0].magicUrl).toMatch(/^rigel:\/\/auth\?token=[A-Za-z0-9_-]+$/);
});

test("verify-link with the emailed token → bearer + account", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const token = new URL(sent[0].magicUrl).searchParams.get("token");
  const res = await json(app, "/auth/verify-link", { token });
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
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code });   // consume via code
  const token = new URL(sent[0].magicUrl).searchParams.get("token");
  expect((await json(app, "/auth/verify-link", { token })).status).toBe(401);   // link now dead
});

test("using the magic link first invalidates the code (shared row)", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const token = new URL(sent[0].magicUrl).searchParams.get("token");
  expect((await json(app, "/auth/verify-link", { token })).status).toBe(200);         // link consumed
  expect((await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).status).toBe(401); // code now dead
});

test("verify-link is rate-limited → 429", async () => {
  const { app } = make({ allow: () => false });
  expect((await json(app, "/auth/verify-link", { token: "anything" })).status).toBe(429);
});
