import { describe, expect, test, vi } from "vitest";
import { createServerClient, VoiceNotConfiguredError } from "./serverClient.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
}

const BASE = "http://127.0.0.1:4321";

describe("createServerClient", () => {
  test("agentConfig sends the worker + session headers", async () => {
    const f = fakeFetch(200, { url: "wss://x", token: "t", model: "m", sttModel: "deepgram/nova-3", ttsModel: "cartesia/sonic-2", apiKey: "k", apiSecret: "s", openrouterApiKey: "o" });
    const c = createServerClient(BASE, "sess", "wt", f);
    const cfg = await c.agentConfig();
    expect(cfg.url).toBe("wss://x");
    const [urlArg, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(urlArg).toBe(`${BASE}/api/voice/agent-config`);
    expect((init as RequestInit).headers).toMatchObject({
      "x-rigel-session": "sess",
      "x-rigel-voice-worker": "wt",
    });
  });

  test("agentConfig throws VoiceNotConfiguredError naming the missing fields on 409", async () => {
    const f = fakeFetch(409, { error: "voice is not configured", missing: ["apiSecret", "openrouterApiKey"] });
    const c = createServerClient(BASE, "sess", "wt", f);
    const err = await c.agentConfig().catch((e) => e);
    expect(err).toBeInstanceOf(VoiceNotConfiguredError);
    expect((err as VoiceNotConfiguredError).missing).toEqual(["apiSecret", "openrouterApiKey"]);
    expect((err as Error).message).toMatch(/apiSecret, openrouterApiKey/);
  });

  test("previewAction posts to /api/action?preview=1 with the context header", async () => {
    const f = fakeFetch(200, { command: ["kubectl", "--context", "prod", "rollout", "restart", "deployment/web"] });
    const c = createServerClient(BASE, "sess", "wt", f);
    const cmd = await c.previewAction({ kind: "restart", label: "Restart web", name: "web" }, "prod");
    expect(cmd.join(" ")).toContain("rollout restart");
    const [urlArg, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(urlArg).toBe(`${BASE}/api/action?preview=1`);
    expect((init as RequestInit).headers).toMatchObject({ "X-Rigel-Context": "prod" });
  });

  test("runAction returns the kubectl result and throws on HTTP failure", async () => {
    const ok = createServerClient(BASE, "s", "w", fakeFetch(200, { code: 0, stdout: "restarted", stderr: "" }));
    expect((await ok.runAction({ kind: "restart", label: "x", name: "web" }, null)).code).toBe(0);
    const bad = createServerClient(BASE, "s", "w", fakeFetch(422, { error: "nope" }));
    await expect(bad.runAction({ kind: "restart", label: "x", name: "web" }, null)).rejects.toThrow("422");
  });
});
