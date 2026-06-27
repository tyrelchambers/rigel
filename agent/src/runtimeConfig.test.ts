import { describe, expect, it, test, vi } from "vitest";
import { parseWindow, inWindow, decideAutonomy, readRuntimeConfig, parseAlertRulesFromConfig, parseMatrixConfig } from "./runtimeConfig.js";
import { kubectl } from "./kubectl.js";
import type { Config } from "./config.js";

vi.mock("./kubectl.js", () => ({ kubectl: vi.fn() }));

const CFG = {
  configConfigMap: "assistant-config",
  stateNamespace: "default",
  workerModel: "claude-sonnet-4-6",
  supervisorModel: "claude-opus-4-8",
  pollIntervalMs: 30_000,
  maxPerResourcePerHour: 3,
  maxPerNight: 20,
  maxAttemptsPerIncident: 3,
  confirmPolls: 2,
  namespaces: [],
} as unknown as Config;

function mockConfigMap(data: Record<string, string>): void {
  vi.mocked(kubectl).mockResolvedValueOnce({
    stdout: JSON.stringify({ data }),
    stderr: "",
    code: 0,
  });
}

describe("parseWindow", () => {
  test("parses HH:MM-HH:MM into minutes-of-day", () => {
    expect(parseWindow("22:00-07:00")).toEqual({ startMin: 1320, endMin: 420 });
    expect(parseWindow("09:30-17:00")).toEqual({ startMin: 570, endMin: 1020 });
  });
  test("returns null on malformed input", () => {
    expect(parseWindow("")).toBeNull();
    expect(parseWindow("nonsense")).toBeNull();
    expect(parseWindow("25:00-07:00")).toBeNull();
  });
});

describe("inWindow", () => {
  test("same-day window", () => {
    const w = { startMin: 570, endMin: 1020 }; // 09:30-17:00
    expect(inWindow(600, w)).toBe(true); // 10:00
    expect(inWindow(540, w)).toBe(false); // 09:00
    expect(inWindow(1020, w)).toBe(false); // 17:00 exclusive end
  });
  test("overnight window (wraps midnight)", () => {
    const w = { startMin: 1320, endMin: 420 }; // 22:00-07:00
    expect(inWindow(1380, w)).toBe(true); // 23:00
    expect(inWindow(60, w)).toBe(true); // 01:00
    expect(inWindow(720, w)).toBe(false); // 12:00
  });
});

describe("decideAutonomy", () => {
  const w = { startMin: 1320, endMin: 420 }; // overnight
  test("auto mode always allows auto-execute", () => {
    expect(decideAutonomy("auto", undefined, 720)).toBe("auto");
  });
  test("advisory mode always queues", () => {
    expect(decideAutonomy("advisory", undefined, 60)).toBe("queue");
  });
  test("window mode auto-executes only inside the window", () => {
    expect(decideAutonomy("window", w, 60)).toBe("auto"); // 01:00 inside
    expect(decideAutonomy("window", w, 720)).toBe("queue"); // 12:00 outside
  });
  test("window mode with no window falls back to queue (safe)", () => {
    expect(decideAutonomy("window", undefined, 60)).toBe("queue");
  });
});

describe("parseAlertRulesFromConfig", () => {
  it("parses the alertRules key, empty when absent", () => {
    expect(parseAlertRulesFromConfig({})).toEqual([]);
    const json = JSON.stringify([{ id: "a", text: "t", target: { scope: "cluster" }, condition: { type: "crashLoop" }, enabled: true, cooldownMinutes: 5, createdAt: "" }]);
    expect(parseAlertRulesFromConfig({ alertRules: json })).toHaveLength(1);
  });
});

describe("readRuntimeConfig — signalInbound", () => {
  test("defaults off, and only the literal \"true\" turns it on", async () => {
    mockConfigMap({ enabled: "true" });
    expect((await readRuntimeConfig(CFG)).signalInbound).toBe(false);

    mockConfigMap({ enabled: "true", signalInbound: "true" });
    expect((await readRuntimeConfig(CFG)).signalInbound).toBe(true);

    mockConfigMap({ enabled: "true", signalInbound: "yes" });
    expect((await readRuntimeConfig(CFG)).signalInbound).toBe(false);
  });

  test("fail-closed (inbound off) when the config map is unreadable", async () => {
    vi.mocked(kubectl).mockResolvedValueOnce({ stdout: "", stderr: "not found", code: 1 });
    expect((await readRuntimeConfig(CFG)).signalInbound).toBe(false);
  });
});

describe("readRuntimeConfig — role selections", () => {
  test("defaults to claude worker=sonnet supervisor=opus when no role keys are set", async () => {
    mockConfigMap({ enabled: "true" });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.worker).toEqual({ provider: "claude", model: "claude-sonnet-4-6", effort: undefined });
    expect(rc.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: undefined });
  });

  test("parses an explicit per-role provider/model/effort", async () => {
    mockConfigMap({
      enabled: "true",
      workerProvider: "gemini", workerModel: "gemini-2.5-pro",
      supervisorProvider: "claude", supervisorModel: "claude-opus-4-8", supervisorEffort: "high",
    });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.worker).toEqual({ provider: "gemini", model: "gemini-2.5-pro", effort: undefined });
    expect(rc.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  });

  test("an unknown provider value falls back to claude (safe default)", async () => {
    mockConfigMap({ enabled: "true", workerProvider: "bogus", workerModel: "x" });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.worker.provider).toBe("claude");
  });

  test("an empty model string falls back to the Config legacy model", async () => {
    mockConfigMap({ enabled: "true", workerProvider: "claude", workerModel: "  " });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.worker.model).toBe("claude-sonnet-4-6");
  });
});

describe("readRuntimeConfig — operational limits", () => {
  test("falls back to Config values when limit keys are absent", async () => {
    mockConfigMap({ enabled: "true" });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.limits).toEqual({
      pollIntervalMs: 30_000, maxPerResourcePerHour: 3, maxPerNight: 20,
      maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [],
    });
  });

  test("parses overrides and ignores non-numeric junk (keeps the Config fallback)", async () => {
    mockConfigMap({
      enabled: "true",
      pollIntervalMs: "15000", maxPerNight: "5", confirmPolls: "nope", namespaces: "default, kube-system",
    });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.limits.pollIntervalMs).toBe(15000);
    expect(rc.limits.maxPerNight).toBe(5);
    expect(rc.limits.confirmPolls).toBe(2); // junk → Config fallback
    expect(rc.limits.namespaces).toEqual(["default", "kube-system"]);
  });

  test("role selections are claude defaults even on an unreadable config map (fail-closed)", async () => {
    vi.mocked(kubectl).mockResolvedValueOnce({ stdout: "", stderr: "nf", code: 1 });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.enabled).toBe(false);
    expect(rc.worker.provider).toBe("claude");
    expect(rc.limits.pollIntervalMs).toBe(30_000);
  });
});

describe("parseMatrixConfig", () => {
  test("reads matrix keys from config and the access token from env", () => {
    const m = parseMatrixConfig(
      {
        matrixHomeserverUrl: " https://hs ",
        matrixUserId: "@rigel:hs",
        matrixRoomId: "!r:hs",
        matrixAllowedSenders: "@me:hs, @you:hs",
        matrixInbound: "true",
      },
      { MATRIX_ACCESS_TOKEN: " tok " } as NodeJS.ProcessEnv,
    );
    expect(m).toEqual({
      homeserverUrl: "https://hs",
      userId: "@rigel:hs",
      accessToken: "tok",
      roomId: "!r:hs",
      allowedSenders: ["@me:hs", "@you:hs"],
      inbound: true,
    });
  });

  test("defaults: no keys/env → undefineds, empty allowlist, inbound false", () => {
    expect(parseMatrixConfig({}, {} as NodeJS.ProcessEnv)).toEqual({
      homeserverUrl: undefined,
      userId: undefined,
      accessToken: undefined,
      roomId: undefined,
      allowedSenders: [],
      inbound: false,
    });
  });
});
