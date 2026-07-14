import type { Hono } from "hono";
import { createHash, randomInt, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthDb } from "./authDb";
import { parseRequestBody, parseVerifyBody } from "./authValidate";

export interface AuthDeps {
  db: AuthDb;
  sendCode: (email: string, code: string) => Promise<void>;
  allowRequest: (key: string) => boolean;
  allowVerify: (key: string) => boolean;
}

const CODE_TTL_SECONDS = 600; // 10 minutes
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function bearer(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function registerAuthRoutes(app: Hono, deps: AuthDeps): void {
  const { db, sendCode, allowRequest, allowVerify } = deps;

  app.post("/auth/request", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const parsed = parseRequestBody(body);
    if (!parsed.ok) return c.json({ error: "invalid email" }, 400);
    const { email } = parsed;
    if (!allowRequest(`auth:req:ip:${clientIp(c)}`) || !allowRequest(`auth:req:email:${email}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.invalidateCodes(email);
    await db.insertCode(email, sha(code), CODE_TTL_SECONDS);
    db.cleanupExpiredCodes().catch(() => {}); // opportunistic, never blocks the response
    try {
      await sendCode(email, code);
    } catch (e) {
      console.error("auth: sendCode failed", e);
      return c.json({ error: "could not send code" }, 502);
    }
    return c.json({ ok: true });
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
    return c.json({ token, account: { email: account.email, name: account.name } });
  });

  app.get("/me", async (c) => {
    const token = bearer(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const account = await db.accountByToken(sha(token));
    if (!account) return c.json({ error: "unauthorized" }, 401);
    await db.touchToken(sha(token));
    return c.json({ account: { email: account.email, name: account.name } });
  });

  app.post("/auth/logout", async (c) => {
    const token = bearer(c);
    if (token) await db.revokeToken(sha(token));
    return c.json({ ok: true });
  });
}
