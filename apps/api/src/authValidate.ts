const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(v: unknown): string {
  return (typeof v === "string" ? v.trim().toLowerCase() : "");
}

type ReqResult = { ok: true; email: string } | { ok: false };
export function parseRequestBody(body: unknown): ReqResult {
  if (typeof body !== "object" || body === null) return { ok: false };
  const email = normalizeEmail((body as Record<string, unknown>).email);
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) return { ok: false };
  return { ok: true, email };
}

type PollResult = { ok: true; pollToken: string } | { ok: false };
export function parsePollBody(body: unknown): PollResult {
  if (typeof body !== "object" || body === null) return { ok: false };
  const raw = (body as Record<string, unknown>).pollToken;
  const pollToken = typeof raw === "string" ? raw.trim() : "";
  if (pollToken.length < 1 || pollToken.length > 512) return { ok: false };
  return { ok: true, pollToken };
}
