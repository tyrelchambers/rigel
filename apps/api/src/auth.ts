import type { Hono } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha, bearer } from "./authToken";
import type { AuthDb } from "./authDb";
import { parsePollBody, parseRequestBody, parseVerifyBody } from "./authValidate";
import { displayCodeFor } from "./displayCode";
import {
  renderConfirmPage,
  renderConfirmedPage,
  renderDeniedPage,
  renderInvalidPage,
  renderRevokePage,
  renderRevokedPage,
} from "./authPages";

export interface AuthDeps {
  db: AuthDb;
  sendLink: (email: string, confirmUrl: string) => Promise<void>;
  sendSignInNotice: (email: string, revokeUrl: string, when: string) => Promise<void>;
  allowRequest: (key: string) => boolean;
  allowVerify: (key: string) => boolean;
  allowPoll: (key: string) => boolean;
  allowPollIp: (key: string) => boolean;
  publicUrl: string;
}

const LOGIN_TTL_SECONDS = 15 * 60; // 15 minutes
const REVOKE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function registerAuthRoutes(app: Hono, deps: AuthDeps): void {
  const { db, sendLink, sendSignInNotice, allowRequest, allowVerify, allowPoll, allowPollIp, publicUrl } = deps;

  app.post("/auth/request", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const parsed = parseRequestBody(body);
    if (!parsed.ok) return c.json({ error: "invalid email" }, 400);
    const { email } = parsed;
    if (!allowRequest(`auth:req:ip:${clientIp(c)}`) || !allowRequest(`auth:req:email:${email}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    const pollToken = randomBytes(32).toString("base64url");
    const confirmToken = randomBytes(32).toString("base64url");
    await db.invalidatePendingLogins(email);
    await db.createPendingLogin({
      email,
      pollTokenHash: sha(pollToken),
      confirmTokenHash: sha(confirmToken),
      ttlSeconds: LOGIN_TTL_SECONDS,
    });
    db.cleanupExpiredPendingLogins().catch(() => {}); // opportunistic, never blocks the response
    try {
      await sendLink(email, `${publicUrl}/auth/confirm?t=${confirmToken}`);
    } catch (e) {
      console.error("auth: sendLink failed", e);
      await db.invalidatePendingLogins(email).catch(() => {}); // best-effort; without the email the row is unconsumable anyway
      return c.json({ error: "could not send link" }, 502);
    }
    return c.json({ pollToken, displayCode: displayCodeFor(sha(pollToken)) });
  });

  app.get("/auth/confirm", async (c) => {
    const token = c.req.query("t") ?? "";
    if (!token) return c.html(renderInvalidPage(), 400);
    const pending = await db.pendingLoginByConfirmHash(sha(token));
    if (!pending) return c.html(renderInvalidPage(), 400);
    return c.html(renderConfirmPage(token, pending.email, displayCodeFor(pending.pollTokenHash)));
  });

  app.post("/auth/confirm", async (c) => {
    const form = await c.req.parseBody();
    const token = typeof form.t === "string" ? form.t.trim() : "";
    const action = typeof form.action === "string" ? form.action : "";
    if (!token) return c.html(renderInvalidPage(), 400);
    if (!allowVerify(`auth:cfm:ip:${clientIp(c)}`)) return c.html(renderInvalidPage(), 429);

    if (action === "deny") {
      const pending = await db.pendingLoginByConfirmHash(sha(token));
      if (pending) await db.invalidatePendingLogins(pending.email);
      return c.html(renderDeniedPage());
    }

    const claimed = await db.confirmPendingLogin(sha(token));
    if (!claimed) return c.html(renderInvalidPage(), 400);
    return c.html(renderConfirmedPage(claimed.email));
  });

  app.get("/auth/revoke", (c) => {
    const token = c.req.query("t") ?? "";
    if (!token) return c.html(renderInvalidPage(), 400);
    return c.html(renderRevokePage(token));
  });

  app.post("/auth/revoke", async (c) => {
    const form = await c.req.parseBody();
    const token = typeof form.t === "string" ? form.t.trim() : "";
    if (!token) return c.html(renderInvalidPage(), 400);
    if (!allowVerify(`auth:rvk:ip:${clientIp(c)}`)) return c.html(renderInvalidPage(), 429);
    const claimed = await db.consumeRevokeToken(sha(token));
    if (!claimed) return c.html(renderInvalidPage(), 400);
    const count = await db.revokeTokensForAccount(claimed.accountId);
    return c.html(renderRevokedPage(count));
  });

  app.post("/auth/verify", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const parsed = parseVerifyBody(body);
    if (!parsed.ok) return c.json({ error: "invalid" }, 400);
    const { email, code } = parsed;
    if (!allowVerify(`auth:vrf:ip:${clientIp(c)}`) || !allowVerify(`auth:vrf:email:${email}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    const claim = await db.claimAttempt(email);
    if (!claim || !timingSafeEqualHex(sha(code), claim.codeHash)) return c.json({ error: "invalid code" }, 401);
    if (!(await db.consumeCode(email))) return c.json({ error: "invalid code" }, 401);
    const account = await db.upsertAccount(email);
    const token = randomBytes(32).toString("base64url");
    await db.insertToken(sha(token), account.id);
    return c.json({ token, account: { id: account.id, email: account.email, name: account.name } });
  });

  app.post("/auth/poll", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const parsed = parsePollBody(body);
    if (!parsed.ok) return c.json({ error: "invalid" }, 400);
    if (!allowPollIp(`auth:poll:ip:${clientIp(c)}`)) return c.json({ error: "rate limited" }, 429);
    const hash = sha(parsed.pollToken);
    if (!allowPoll(`auth:poll:${hash}`)) return c.json({ error: "rate limited" }, 429);
    const claimed = await db.consumeConfirmedLogin(hash);
    if (claimed) {
      const account = await db.upsertAccount(claimed.email);
      const token = randomBytes(32).toString("base64url");
      await db.insertToken(sha(token), account.id);
      const revokeToken = randomBytes(32).toString("base64url");
      await db.createRevokeToken({ tokenHash: sha(revokeToken), accountId: account.id, ttlSeconds: REVOKE_TTL_SECONDS });
      void sendSignInNotice(account.email, `${publicUrl}/auth/revoke?t=${revokeToken}`, new Date().toISOString())
        .catch((e) => console.error("auth: sendSignInNotice failed", e));
      return c.json({
        status: "confirmed",
        token,
        account: { id: account.id, email: account.email, name: account.name },
      });
    }
    if (await db.pendingLoginActive(hash)) return c.json({ status: "pending" });
    return c.json({ status: "expired" }, 404);
  });

  app.post("/auth/verify-link", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const token = typeof (body as { token?: unknown })?.token === "string" ? (body as { token: string }).token.trim() : "";
    if (!token) return c.json({ error: "invalid" }, 400);
    if (!allowVerify(`auth:vrf:ip:${clientIp(c)}`)) return c.json({ error: "rate limited" }, 429);
    const claimed = await db.consumeLinkToken(sha(token));
    if (!claimed) return c.json({ error: "invalid or expired link" }, 401);
    const account = await db.upsertAccount(claimed.email);
    const bearer = randomBytes(32).toString("base64url");
    await db.insertToken(sha(bearer), account.id);
    return c.json({ token: bearer, account: { id: account.id, email: account.email, name: account.name } });
  });

  app.get("/me", async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const account = await db.accountByToken(sha(token));
    if (!account) return c.json({ error: "unauthorized" }, 401);
    await db.touchToken(sha(token));
    let orgs = await db.getOrgsForAccount(account.id);
    if (orgs.length === 0) {
      // Self-heal: any signed-in account must have a personal org. Covers an
      // account that predates orgs and slipped past the boot backfill.
      await db.ensurePersonalOrg(account.id, account.name ?? account.email);
      orgs = await db.getOrgsForAccount(account.id);
    }
    return c.json({ account: { id: account.id, email: account.email, name: account.name }, orgs });
  });

  app.post("/auth/logout", async (c) => {
    const token = bearer(c);
    if (token) await db.revokeToken(sha(token));
    return c.json({ ok: true });
  });
}
