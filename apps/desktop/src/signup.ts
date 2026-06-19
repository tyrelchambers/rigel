import type { InstallStore, SignupPayload } from "./installStore";

/** POST the pending payload; clear it on a 2xx. Returns true if delivered (or nothing pending). */
export async function deliver(store: InstallStore, fetchFn: typeof fetch, endpoint: string, appKey: string): Promise<boolean> {
  const p = store.pending;
  if (!p) return true;
  try {
    const res = await fetchFn(`${endpoint}/signups`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rigel-key": appKey },
      body: JSON.stringify(p),
    });
    if (res.ok) { store.clearPending(); return true; }
    return false;
  } catch { return false; }
}

/** Gate satisfied the instant the user submits: capture locally, then best-effort deliver. */
export async function submitSignup(
  store: InstallStore, fetchFn: typeof fetch, endpoint: string, appKey: string,
  name: string, email: string, appVersion: string, platform: string,
): Promise<{ ok: true }> {
  const payload: SignupPayload = { installId: store.installId, name, email, appVersion, platform };
  store.setCapturedWithPending(payload);
  await deliver(store, fetchFn, endpoint, appKey);
  return { ok: true };
}
