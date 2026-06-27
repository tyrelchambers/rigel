// apps/server/src/matrix.test.ts
import { test, expect, describe } from "vitest";
import {
  normalizeHomeserver,
  loginRequest,
  whoamiRequest,
  createRoomRequest,
  handleMatrix,
  evaluatePoll,
  pollRequest,
  sendTestRequest,
} from "./matrix";

test("normalizeHomeserver trims whitespace and trailing slashes", () => {
  expect(normalizeHomeserver("  https://hs.example/  ")).toBe("https://hs.example");
  expect(normalizeHomeserver("https://hs.example///")).toBe("https://hs.example");
});

test("loginRequest targets v3/login with an m.login.password body", () => {
  const { url, body } = loginRequest("https://hs", "rigel", "pw");
  expect(url).toBe("https://hs/_matrix/client/v3/login");
  expect(body).toEqual({ type: "m.login.password", identifier: { type: "m.id.user", user: "rigel" }, password: "pw" });
});

test("whoamiRequest targets v3 whoami with a bearer header", () => {
  const { url, headers } = whoamiRequest("https://hs/", "tok");
  expect(url).toBe("https://hs/_matrix/client/v3/account/whoami");
  expect(headers.authorization).toBe("Bearer tok");
});

test("createRoomRequest creates an UNENCRYPTED private room with invites", () => {
  const { url, headers, body } = createRoomRequest("https://hs", "tok", { name: "Rigel", invite: ["@me:hs"] });
  expect(url).toBe("https://hs/_matrix/client/v3/createRoom");
  expect(headers.authorization).toBe("Bearer tok");
  expect(body).toEqual({ preset: "private_chat", name: "Rigel", invite: ["@me:hs"], is_direct: false });
  // Never request encryption — the room must stay unencrypted.
  expect(JSON.stringify(body)).not.toContain("m.room.encryption");
});

describe("handleMatrix guards (short-circuit before any network call)", () => {
  test("login requires homeserver + user + password", async () => {
    const r1 = await handleMatrix({ action: "login", user: "r", password: "p" });
    expect(r1.kind).toBe("error");
    if (r1.kind === "error") expect(r1.status).toBe(422);

    const r2 = await handleMatrix({ action: "login", homeserver: "https://hs", password: "p" });
    expect(r2.kind).toBe("error");
    if (r2.kind === "error") expect(r2.status).toBe(422);

    const r3 = await handleMatrix({ action: "login", homeserver: "https://hs", user: "r" });
    expect(r3.kind).toBe("error");
    if (r3.kind === "error") expect(r3.status).toBe(422);
  });

  test("validate requires homeserver + accessToken", async () => {
    const r1 = await handleMatrix({ action: "validate", homeserver: "https://hs" });
    expect(r1.kind).toBe("error");
    if (r1.kind === "error") expect(r1.status).toBe(422);

    const r2 = await handleMatrix({ action: "validate", accessToken: "t" });
    expect(r2.kind).toBe("error");
    if (r2.kind === "error") expect(r2.status).toBe(422);
  });

  test("createRoom requires homeserver + accessToken", async () => {
    const r = await handleMatrix({ action: "createRoom", homeserver: "https://hs" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.status).toBe(422);
  });

  test("poll requires homeserver + accessToken + roomId", async () => {
    const missing = [
      { action: "poll" as const, accessToken: "t", roomId: "!r:hs" },           // no homeserver
      { action: "poll" as const, homeserver: "https://hs", roomId: "!r:hs" },   // no token
      { action: "poll" as const, homeserver: "https://hs", accessToken: "t" },  // no roomId
    ];
    for (const req of missing) {
      const r = await handleMatrix(req);
      expect(r.kind).toBe("error");
      if (r.kind === "error") expect(r.status).toBe(422);
    }
  });

  test("sendTest requires homeserver + accessToken + roomId", async () => {
    const missing = [
      { action: "sendTest" as const, accessToken: "t", roomId: "!r:hs" },
      { action: "sendTest" as const, homeserver: "https://hs", roomId: "!r:hs" },
      { action: "sendTest" as const, homeserver: "https://hs", accessToken: "t" },
    ];
    for (const req of missing) {
      const r = await handleMatrix(req);
      expect(r.kind).toBe("error");
      if (r.kind === "error") expect(r.status).toBe(422);
    }
  });

  test("an unknown action is a 422 error", async () => {
    // @ts-expect-error — exercising the default branch
    const r = await handleMatrix({ action: "bogus" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.status).toBe(422);
  });
});

// ── evaluatePoll ────────────────────────────────────────────────────────────
describe("evaluatePoll", () => {
  const BOT = "@rigel:hs";
  const USER = "@me:hs";
  const opts = { botUserId: BOT, allowedSenders: [USER] };

  function msg(sender: string, ts: number) {
    return { type: "m.room.message", sender, origin_server_ts: ts };
  }

  test("no events → userMessaged=false, botReplied=false", () => {
    expect(evaluatePoll([], opts)).toEqual({ userMessaged: false, botReplied: false });
  });

  test("user message only → userMessaged=true, botReplied=false", () => {
    expect(evaluatePoll([msg(USER, 1000)], opts)).toEqual({ userMessaged: true, botReplied: false });
  });

  test("user message then bot reply → both true", () => {
    const events = [msg(USER, 1000), msg(BOT, 2000)];
    expect(evaluatePoll(events, opts)).toEqual({ userMessaged: true, botReplied: true });
  });

  test("bot message BEFORE user → botReplied=false (pre-existing bot msg does not count)", () => {
    const events = [msg(BOT, 500), msg(USER, 1000)];
    expect(evaluatePoll(events, opts)).toEqual({ userMessaged: true, botReplied: false });
  });

  test("malformed events are skipped without throwing", () => {
    const events = [null, undefined, {}, { type: "m.room.message" }, { type: "m.room.message", sender: 42 }, msg(USER, 1000)];
    expect(() => evaluatePoll(events as unknown[], opts)).not.toThrow();
    expect(evaluatePoll(events as unknown[], opts)).toEqual({ userMessaged: true, botReplied: false });
  });

  test("non-m.room.message event types are ignored", () => {
    const events = [
      { type: "m.room.member", sender: USER, origin_server_ts: 1000 },
      { type: "m.reaction", sender: BOT, origin_server_ts: 2000 },
    ];
    expect(evaluatePoll(events, opts)).toEqual({ userMessaged: false, botReplied: false });
  });
});

// ── pollRequest ─────────────────────────────────────────────────────────────
describe("pollRequest", () => {
  test("returns correct GET URL with encoded roomId and Bearer header", () => {
    const { url, headers } = pollRequest("https://hs/", "tok", "!room:hs");
    expect(url).toBe(
      "https://hs/_matrix/client/v3/rooms/%21room%3Ahs/messages?dir=b&limit=50",
    );
    expect(headers.authorization).toBe("Bearer tok");
  });
});

// ── sendTestRequest ─────────────────────────────────────────────────────────
describe("sendTestRequest", () => {
  test("returns PUT URL with encoded roomId, Bearer header, and m.text body", () => {
    const { url, headers, body } = sendTestRequest("https://hs", "tok", "!room:hs");
    expect(url).toMatch(
      /^https:\/\/hs\/_matrix\/client\/v3\/rooms\/%21room%3Ahs\/send\/m\.room\.message\/.+$/,
    );
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["content-type"]).toBe("application/json");
    const b = body as { msgtype: string; body: string };
    expect(b.msgtype).toBe("m.text");
    expect(b.body).toMatch(/Test from Rigel/);
  });

  test("generates a unique txnId on each call", () => {
    const a = sendTestRequest("https://hs", "tok", "!r:hs");
    const b = sendTestRequest("https://hs", "tok", "!r:hs");
    expect(a.url).not.toBe(b.url);
  });
});
