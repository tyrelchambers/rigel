import { describe, it, expect, vi, afterEach } from "vitest";
import { matrixLogin, matrixValidate, matrixCreateRoom } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("matrix api helpers", () => {
  it("matrixLogin posts credentials and returns the result", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ accessToken: "tok", userId: "@rigel:hs" }), { status: 200 }));
    const r = await matrixLogin("https://hs", "rigel", "pw");
    expect(r).toEqual({ accessToken: "tok", userId: "@rigel:hs" });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/matrix");
    expect(JSON.parse(String(init?.body))).toEqual({ action: "login", homeserver: "https://hs", user: "rigel", password: "pw" });
  });

  it("matrixValidate posts the token and returns the user id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ userId: "@rigel:hs" }), { status: 200 }));
    const r = await matrixValidate("https://hs", "tok");
    expect(r).toEqual({ userId: "@rigel:hs" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ action: "validate", homeserver: "https://hs", accessToken: "tok" });
  });

  it("matrixCreateRoom posts invites and returns the room id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ roomId: "!r:hs" }), { status: 200 }));
    const r = await matrixCreateRoom("https://hs", "tok", "Rigel", ["@me:hs"]);
    expect(r).toEqual({ roomId: "!r:hs" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ action: "createRoom", homeserver: "https://hs", accessToken: "tok", roomName: "Rigel", invite: ["@me:hs"] });
  });

  it("throws the server error message on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 400 }),
    );
    await expect(matrixLogin("https://hs", "r", "p")).rejects.toThrow(/boom/);
  });
});
