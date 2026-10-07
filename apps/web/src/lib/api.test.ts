import { afterEach, describe, expect, test, vi } from "vitest";
import { applyManifestYaml, fetchRecentDeploys, fetchVoiceToken, undoDeploy, VoiceAgentUnavailableError } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("applyManifestYaml", () => {
  test("includes source in the POST body when provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "" }), { status: 200 }));
    await applyManifestYaml("kind: X", false, "compose-migration");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ yaml: "kind: X", dryRun: false, source: "compose-migration" });
  });

  test("omits source when not provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "" }), { status: 200 }));
    await applyManifestYaml("kind: X", true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ yaml: "kind: X", dryRun: true });
  });
});

describe("recent deploys api", () => {
  test("fetchRecentDeploys GETs the recent endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ batches: [] }), { status: 200 }));
    expect(await fetchRecentDeploys()).toEqual({ batches: [] });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/deployments/recent");
  });

  test("undoDeploy POSTs the batchId + ledger namespace", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 }));
    await undoDeploy("b1", "shop");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/deployments/undo");
    expect(JSON.parse(init!.body as string)).toEqual({ batchId: "b1", namespace: "shop" });
  });
});

describe("fetchVoiceToken", () => {
  test("returns the room it minted alongside the token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "wss://x", token: "jwt", room: "rigel-desktop-0a1b2c3d" }), { status: 200 }),
    );
    expect(await fetchVoiceToken()).toEqual({ url: "wss://x", token: "jwt", room: "rigel-desktop-0a1b2c3d" });
  });

  test("a 503 is the agent being unavailable, with the server's own words", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "The voice agent isn't running." }), { status: 503 }),
    );
    const err = await fetchVoiceToken().catch((e) => e);
    expect(err).toBeInstanceOf(VoiceAgentUnavailableError);
    expect((err as Error).message).toBe("The voice agent isn't running.");
  });

  test("any other failure stays a plain error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 409 }));
    const err = await fetchVoiceToken().catch((e) => e);
    expect(err).not.toBeInstanceOf(VoiceAgentUnavailableError);
    expect((err as Error).message).toMatch(/409/);
  });
});
