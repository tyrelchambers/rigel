// Matrix connect proxy — server side of the connect wizard (mirrors signal.ts).
//
// POST /api/matrix dispatches on `action`:
//   login     → POST /_matrix/client/v3/login (m.login.password), returns
//               { accessToken, userId }; the password is used once and discarded.
//   validate  → GET  /_matrix/client/v3/account/whoami, returns { userId } (a
//               reachability + token check).
//   createRoom→ POST /_matrix/client/v3/createRoom, creates an UNENCRYPTED room
//               and invites the allowed senders, returns { roomId }.
//   poll      → GET  room messages, returns { userMessaged, botReplied }.
//   sendTest  → PUT  a test m.text message into the room, returns { ok: true }.
//
// All calls are outbound HTTP to the user's homeserver (no kubectl). Never
// throws — failures return an { kind: "error" } so the route picks the status.

export type MatrixAction = "login" | "validate" | "createRoom" | "poll" | "sendTest";

export interface MatrixRequest {
  action: MatrixAction;
  homeserver?: string;
  user?: string;
  password?: string;
  accessToken?: string;
  roomName?: string;
  invite?: string[];
  // poll + sendTest
  roomId?: string;
  botUserId?: string;
  allowedSenders?: string[];
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

/** Encode a Matrix room ID for use in a URL path segment.
 * encodeURIComponent leaves '!' unencoded (safe-char set); Matrix room IDs
 * start with '!' so we encode it explicitly to produce clean %21 paths. */
function encodeRoomId(roomId: string): string {
  return encodeURIComponent(roomId).replace(/!/g, "%21");
}

/** GET the last 50 messages in a room (backwards from latest). */
export function pollRequest(
  homeserver: string,
  accessToken: string,
  roomId: string,
): { url: string; headers: Record<string, string> } {
  return {
    url: `${normalizeHomeserver(homeserver)}/_matrix/client/v3/rooms/${encodeRoomId(roomId)}/messages?dir=b&limit=50`,
    headers: { authorization: `Bearer ${accessToken}` },
  };
}

export interface PollEvalOpts {
  botUserId: string;
  allowedSenders: string[];
}

export interface PollResult {
  userMessaged: boolean;
  botReplied: boolean;
}

/**
 * Evaluate whether a user has messaged and the bot has replied, given a raw
 * chunk of Matrix events. Pure — never throws; malformed events are skipped.
 *
 * Logic:
 *  - Only m.room.message events are considered.
 *  - "User message" = sender is in allowedSenders AND is not the bot.
 *  - If no user messages found → { userMessaged: false, botReplied: false }.
 *  - Otherwise firstUserTs = min(origin_server_ts of user msgs).
 *  - botReplied = any m.room.message from botUserId with ts > firstUserTs.
 *    (A bot message that pre-dates the user's first text does NOT count as a reply.)
 */
export function evaluatePoll(events: unknown[], opts: PollEvalOpts): PollResult {
  const { botUserId, allowedSenders } = opts;

  // Defensive filter: only well-formed m.room.message events.
  const msgEvents = events.filter(
    (e): e is { type: string; sender: string; origin_server_ts: number } => {
      if (e == null || typeof e !== "object") return false;
      const ev = e as Record<string, unknown>;
      return (
        ev.type === "m.room.message" &&
        typeof ev.sender === "string" &&
        typeof ev.origin_server_ts === "number"
      );
    },
  );

  const userMsgs = msgEvents.filter(
    (e) => allowedSenders.includes(e.sender) && e.sender !== botUserId,
  );

  if (userMsgs.length === 0) return { userMessaged: false, botReplied: false };

  const firstUserTs = Math.min(...userMsgs.map((e) => e.origin_server_ts));
  const botReplied = msgEvents.some(
    (e) => e.sender === botUserId && e.origin_server_ts > firstUserTs,
  );

  return { userMessaged: true, botReplied };
}

/** PUT a test message into the room via a unique transaction id. */
export function sendTestRequest(
  homeserver: string,
  accessToken: string,
  roomId: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const txnId = `rigel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    url: `${normalizeHomeserver(homeserver)}/_matrix/client/v3/rooms/${encodeRoomId(roomId)}/send/m.room.message/${txnId}`,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: {
      msgtype: "m.text",
      body: '👋 Test from Rigel — your Matrix channel is connected. Text me "status" any time.',
    },
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
      case "poll": {
        const homeserver = normalizeHomeserver(req.homeserver ?? "");
        const accessToken = (req.accessToken ?? "").trim();
        const roomId = (req.roomId ?? "").trim();
        if (homeserver === "" || accessToken === "" || roomId === "") {
          return { kind: "error", status: 422, message: "homeserver, accessToken, and roomId are required." };
        }
        const botUserId = (req.botUserId ?? "").trim();
        const allowedSenders = req.allowedSenders ?? [];
        try {
          const { url, headers } = pollRequest(homeserver, accessToken, roomId);
          const res = await fetch(url, { headers });
          if (!res.ok) {
            return { kind: "error", status: 502, message: `Poll failed: HTTP ${res.status}` };
          }
          const data = (await res.json()) as { chunk?: unknown[] };
          const chunk = Array.isArray(data.chunk) ? data.chunk : [];
          return { kind: "json", body: evaluatePoll(chunk, { botUserId, allowedSenders }) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { kind: "error", status: 502, message: `Poll failed: ${message}` };
        }
      }
      case "sendTest": {
        const homeserver = normalizeHomeserver(req.homeserver ?? "");
        const accessToken = (req.accessToken ?? "").trim();
        const roomId = (req.roomId ?? "").trim();
        if (homeserver === "" || accessToken === "" || roomId === "") {
          return { kind: "error", status: 422, message: "homeserver, accessToken, and roomId are required." };
        }
        try {
          const { url, headers, body } = sendTestRequest(homeserver, accessToken, roomId);
          const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
          if (!res.ok) {
            return { kind: "error", status: 502, message: `Send test failed: HTTP ${res.status}` };
          }
          return { kind: "json", body: { ok: true } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { kind: "error", status: 502, message: `Send test failed: ${message}` };
        }
      }
      default:
        return { kind: "error", status: 422, message: `unknown action: ${String((req as { action?: string }).action)}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", status: 502, message: `Could not reach the homeserver: ${message}` };
  }
}
