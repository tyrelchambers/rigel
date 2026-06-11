// Built-in browser auth for self-hosters: a single admin password gates the app
// via a signed, httpOnly session cookie. Cookies (unlike custom headers) ride
// the WebSocket handshake automatically, so this covers both /api and /ws.
//
// Stateless: the cookie is `<exp>.<HMAC(exp)>` signed with a server secret, so it
// survives nothing-shared across replicas and needs no session store. A random
// signing secret is generated at startup unless HELMSMAN_SESSION_SECRET is set
// (set it to keep sessions valid across restarts / multiple replicas).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PASSWORD = process.env.HELMSMAN_PASSWORD?.trim() || null;
const SECRET = process.env.HELMSMAN_SESSION_SECRET?.trim() || randomBytes(32).toString("hex");
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const COOKIE_NAME = "helmsman_session";

/** True when an admin password is configured (browser auth is enforced). */
export function passwordConfigured(): boolean {
  return PASSWORD !== null;
}

/** Constant-time compare of a submitted password against the configured one. */
export function passwordMatches(input: string): boolean {
  if (!PASSWORD) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

/** Mint a cookie value `<exp>.<sig>` valid for TTL from `now` (ms epoch). */
export function issueSession(now: number): string {
  const payload = String(now + TTL_SECONDS * 1000);
  return `${payload}.${sign(payload)}`;
}

/** Validate a cookie value: signature intact (constant-time) and not expired. */
export function sessionValid(value: string | undefined, now: number): boolean {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(payload);
  if (mac.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > now;
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Whether the request carries a valid session cookie. */
export function hasValidSession(req: Request, now: number): boolean {
  return sessionValid(readCookie(req.headers.get("cookie") ?? undefined, COOKIE_NAME), now);
}

/** Set-Cookie header for a fresh session. `Secure` only over HTTPS so the
 *  cookie still works for http LAN / port-forward access (use TLS in prod). */
export function sessionSetCookie(req: Request, now: number): string {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const attrs = [
    `${COOKIE_NAME}=${issueSession(now)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${TTL_SECONDS}`,
  ];
  if (proto === "https") attrs.push("Secure");
  return attrs.join("; ");
}

export function sessionClearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
