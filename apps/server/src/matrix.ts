// Matrix connect proxy — server side of the connect wizard (mirrors signal.ts).
//
// POST /api/matrix dispatches on `action`:
//   login     → POST /_matrix/client/v3/login (m.login.password), returns
//               { accessToken, userId }; the password is used once and discarded.
//   validate  → GET  /_matrix/client/v3/account/whoami, returns { userId } (a
//               reachability + token check).
//   createRoom→ POST /_matrix/client/v3/createRoom, creates an UNENCRYPTED room
//               and invites the allowed senders, returns { roomId }.
//
// All calls are outbound HTTP to the user's homeserver (no kubectl). Never
// throws — failures return an { kind: "error" } so the route picks the status.

export type MatrixAction = "login" | "validate" | "createRoom";

export interface MatrixRequest {
  action: MatrixAction;
  homeserver?: string;
  user?: string;
  password?: string;
  accessToken?: string;
  roomName?: string;
  invite?: string[];
}

export type MatrixResult =
  | { kind: "json"; body: unknown }
  | { kind: "error"; status: number; message: string };

/** Trim and drop trailing slashes from a homeserver base URL. */
export function normalizeHomeserver(raw: string): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

export function loginRequest(
  homeserver: string,
  user: string,
  password: string,
): { url: string; body: unknown } {
  return {
    url: `${normalizeHomeserver(homeserver)}/_matrix/client/v3/login`,
    body: { type: "m.login.password", identifier: { type: "m.id.user", user }, password },
  };
}

export function whoamiRequest(
  homeserver: string,
  accessToken: string,
): { url: string; headers: Record<string, string> } {
  return {
    url: `${normalizeHomeserver(homeserver)}/_matrix/client/v3/account/whoami`,
    headers: { authorization: `Bearer ${accessToken}` },
  };
}

export function createRoomRequest(
  homeserver: string,
  accessToken: string,
  opts: { name: string; invite: string[] },
): { url: string; headers: Record<string, string>; body: unknown } {
  return {
    url: `${normalizeHomeserver(homeserver)}/_matrix/client/v3/createRoom`,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    // No m.room.encryption initial_state → an UNENCRYPTED room. Element X refuses
    // to create these, so Rigel (the bot) provisions it. Privacy comes from
    // server ownership, not E2E (see the design doc).
    body: { preset: "private_chat", name: opts.name, invite: opts.invite, is_direct: false },
  };
}

/** Route a parsed Matrix request. Never throws — see the module header. */
export async function handleMatrix(req: MatrixRequest): Promise<MatrixResult> {
  try {
    switch (req.action) {
      case "login": {
        const homeserver = normalizeHomeserver(req.homeserver ?? "");
        const user = (req.user ?? "").trim();
        const password = req.password ?? "";
        if (homeserver === "") return { kind: "error", status: 422, message: "Enter your homeserver URL." };
        if (user === "" || password === "") return { kind: "error", status: 422, message: "Enter the bot username and password." };
        const { url, body } = loginRequest(homeserver, user, password);
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) {
          const status = res.status === 401 || res.status === 403 ? 401 : 502;
          return { kind: "error", status, message: `Login failed: ${(await res.text().catch(() => "")).trim() || `HTTP ${res.status}`}` };
        }
        const data = (await res.json()) as { access_token?: string; user_id?: string };
        if (!data.access_token) return { kind: "error", status: 502, message: "Login succeeded but no access token was returned." };
        return { kind: "json", body: { accessToken: data.access_token, userId: data.user_id ?? "" } };
      }
      case "validate": {
        const homeserver = normalizeHomeserver(req.homeserver ?? "");
        const accessToken = (req.accessToken ?? "").trim();
        if (homeserver === "") return { kind: "error", status: 422, message: "Enter your homeserver URL." };
        if (accessToken === "") return { kind: "error", status: 422, message: "Paste the bot access token." };
        const { url, headers } = whoamiRequest(homeserver, accessToken);
        const res = await fetch(url, { headers });
        if (!res.ok) {
          const status = res.status === 401 ? 401 : 502;
          return { kind: "error", status, message: `Token check failed: HTTP ${res.status}` };
        }
        const data = (await res.json()) as { user_id?: string };
        return { kind: "json", body: { userId: data.user_id ?? "" } };
      }
      case "createRoom": {
        const homeserver = normalizeHomeserver(req.homeserver ?? "");
        const accessToken = (req.accessToken ?? "").trim();
        if (homeserver === "") return { kind: "error", status: 422, message: "Enter your homeserver URL." };
        if (accessToken === "") return { kind: "error", status: 422, message: "Connect the bot account first." };
        const { url, headers, body } = createRoomRequest(homeserver, accessToken, {
          name: req.roomName?.trim() || "Rigel",
          invite: req.invite ?? [],
        });
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res.ok) {
          return { kind: "error", status: 502, message: `Could not create the room: ${(await res.text().catch(() => "")).trim() || `HTTP ${res.status}`}` };
        }
        const data = (await res.json()) as { room_id?: string };
        if (!data.room_id) return { kind: "error", status: 502, message: "Room created but no room id was returned." };
        return { kind: "json", body: { roomId: data.room_id } };
      }
      default:
        return { kind: "error", status: 422, message: `unknown action: ${String((req as { action?: string }).action)}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", status: 502, message: `Could not reach the homeserver: ${message}` };
  }
}
