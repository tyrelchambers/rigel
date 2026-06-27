// apps/server/src/matrix.test.ts
import { test, expect, describe } from "vitest";
import {
  normalizeHomeserver,
  loginRequest,
  whoamiRequest,
  createRoomRequest,
  handleMatrix,
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

  test("an unknown action is a 422 error", async () => {
    // @ts-expect-error — exercising the default branch
    const r = await handleMatrix({ action: "bogus" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.status).toBe(422);
  });
});
