import type { Signup } from "./validate";

// Kit (formerly ConvertKit) v4 sync. After a signup is stored in Postgres we
// also upsert the person into the Kit audience and apply the waitlist tag, so
// the marketing waitlist and the desktop first-run both flow into Kit. The Kit
// call is best-effort: the caller swallows failures so a Kit outage never fails
// the signup (Postgres stays the source of truth).

export interface KitConfig {
  /** Kit v4 API key. Empty string disables the integration (returns a no-op). */
  apiKey: string;
  /** Tag applied to each signup, or null to skip tagging. */
  tagId: number | null;
  /** Override for tests; defaults to the Kit v4 base URL. */
  baseUrl?: string;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a notifier that upserts a signup into Kit and applies the tag. Returns a
 * no-op when no apiKey is configured, so the service runs in dev/CI without Kit.
 */
export function createKitNotifier(cfg: KitConfig): (s: Signup) => Promise<void> {
  if (!cfg.apiKey) return async () => {};
  const f = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl ?? "https://api.kit.com/v4";
  const headers = { "Content-Type": "application/json", "X-Kit-Api-Key": cfg.apiKey };

  return async (s: Signup) => {
    // Upsert into the audience (creates the subscriber if new; idempotent).
    const sub = await f(`${base}/subscribers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email_address: s.email, first_name: s.name }),
    });
    if (!sub.ok) throw new Error(`kit subscribers ${sub.status}`);

    if (cfg.tagId != null) {
      const tag = await f(`${base}/tags/${cfg.tagId}/subscribers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email_address: s.email }),
      });
      if (!tag.ok) throw new Error(`kit tag ${tag.status}`);
    }
  };
}
