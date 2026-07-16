export interface Signup {
  installId: string;
  name: string;
  email: string;
  appVersion: string;
  platform: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Result = { ok: true; value: Signup } | { ok: false; error: string };

export function parseSignup(body: unknown): Result {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const installId = str(b.installId);
  const name = str(b.name);
  const email = str(b.email);
  const appVersion = str(b.appVersion).slice(0, 50);
  const platform = str(b.platform).slice(0, 50);
  if (!UUID.test(installId)) return { ok: false, error: "invalid installId" };
  if (name.length < 1 || name.length > 200) return { ok: false, error: "invalid name" };
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) return { ok: false, error: "invalid email" };
  return { ok: true, value: { installId, name, email, appVersion, platform } };
}
