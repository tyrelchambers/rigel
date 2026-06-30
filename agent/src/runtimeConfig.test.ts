import { describe, expect, it, test, vi } from "vitest";
import { parseWindow, inWindow, decideAutonomy, readRuntimeConfig, parseAlertRulesFromConfig, parseMatrixConfig, parseAutofixConfig, parseAutofixScope, parseAutofixMaxPerDay } from "./runtimeConfig.js";
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

describe("parseAutofixScope", () => {
  test("empty / absent / malformed → empty scope", () => {
    expect(parseAutofixScope(undefined)).toEqual({ projects: [] });
    expect(parseAutofixScope("")).toEqual({ projects: [] });
    expect(parseAutofixScope("not json")).toEqual({ projects: [] });
  });
  test("parses projects, trimming and dropping non-strings", () => {
    const raw = JSON.stringify({ projects: [" prod/api ", "staging/web", 7, ""] });
    expect(parseAutofixScope(raw)).toEqual({ projects: ["prod/api", "staging/web"] });
  });
  test("missing projects key defaults to an empty array", () => {
    expect(parseAutofixScope(JSON.stringify({}))).toEqual({ projects: [] });
  });
  test("tolerates a legacy stored `namespaces` key WITHOUT using it", () => {
    // Pre-per-project installs may still have a namespaces key persisted; it must
    // never crash and never widen the scope — only `projects` is honored.
    const raw = JSON.stringify({ namespaces: ["prod", "staging"], projects: ["prod/api"] });
    expect(parseAutofixScope(raw)).toEqual({ projects: ["prod/api"] });
    expect(parseAutofixScope(JSON.stringify({ namespaces: ["prod"] }))).toEqual({ projects: [] });
  });
});

describe("parseAutofixMaxPerDay", () => {
  test("defaults to 5 when absent/blank", () => {
    expect(parseAutofixMaxPerDay(undefined)).toBe(5);
    expect(parseAutofixMaxPerDay("")).toBe(5);
    expect(parseAutofixMaxPerDay("   ")).toBe(5);
  });
  test("parses a whole-number override (floored)", () => {
    expect(parseAutofixMaxPerDay("3")).toBe(3);
    expect(parseAutofixMaxPerDay("2.9")).toBe(2);
    expect(parseAutofixMaxPerDay("0")).toBe(0); // 0 honored — no fix PRs
  });
  test("fails safe to the default on garbage / negatives", () => {
    expect(parseAutofixMaxPerDay("nope")).toBe(5);
    expect(parseAutofixMaxPerDay("-1")).toBe(5);
    expect(parseAutofixMaxPerDay("NaN")).toBe(5);
  });
});

describe("parseAutofixConfig", () => {
  test("defaults disabled + empty scope + maxPerDay 5 when keys absent", () => {
    expect(parseAutofixConfig({})).toEqual({ enabled: false, scope: { projects: [] }, maxPerDay: 5 });
  });
  test("only the literal \"true\" enables autofix", () => {
    expect(parseAutofixConfig({ autofixEnabled: "true" }).enabled).toBe(true);
    expect(parseAutofixConfig({ autofixEnabled: "yes" }).enabled).toBe(false);
    expect(parseAutofixConfig({ autofixEnabled: "1" }).enabled).toBe(false);
  });
  test("parses the scope + per-day cap alongside the enable flag", () => {
    const cfg = parseAutofixConfig({
      autofixEnabled: "true",
      autofixScope: JSON.stringify({ projects: ["prod/api"] }),
      autofixMaxPerDay: "3",
    });
    expect(cfg).toEqual({ enabled: true, scope: { projects: ["prod/api"] }, maxPerDay: 3 });
  });
});

describe("readRuntimeConfig — autofix", () => {
  test("defaults off + empty scope + maxPerDay 5 when keys are absent", async () => {
    mockConfigMap({ enabled: "true" });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.autofix).toEqual({ enabled: false, scope: { projects: [] }, maxPerDay: 5 });
  });
  test("reads the enable flag + scope + per-day cap from the config map", async () => {
    mockConfigMap({
      enabled: "true",
      autofixEnabled: "true",
      autofixScope: JSON.stringify({ projects: ["default/memos"] }),
      autofixMaxPerDay: "2",
    });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.autofix).toEqual({ enabled: true, scope: { projects: ["default/memos"] }, maxPerDay: 2 });
  });
  test("fail-closed (autofix off) on an unreadable config map", async () => {
    vi.mocked(kubectl).mockResolvedValueOnce({ stdout: "", stderr: "nf", code: 1 });
    expect((await readRuntimeConfig(CFG)).autofix.enabled).toBe(false);
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

  test("MATRIX_HOMESERVER_URL env overrides matrixHomeserverUrl from config", () => {
    const m = parseMatrixConfig(
      { matrixHomeserverUrl: "https://config-hs" },
      { MATRIX_HOMESERVER_URL: "http://synapse.personal.svc.cluster.local:8008" } as NodeJS.ProcessEnv,
    );
    expect(m.homeserverUrl).toBe("http://synapse.personal.svc.cluster.local:8008");
  });

  test("falls back to matrixHomeserverUrl from config when MATRIX_HOMESERVER_URL is unset", () => {
    const m = parseMatrixConfig(
      { matrixHomeserverUrl: "https://config-hs" },
      {} as NodeJS.ProcessEnv,
    );
    expect(m.homeserverUrl).toBe("https://config-hs");
  });

  test("ignores a blank MATRIX_HOMESERVER_URL and falls back to config", () => {
    const m = parseMatrixConfig(
      { matrixHomeserverUrl: "https://config-hs" },
      { MATRIX_HOMESERVER_URL: "   " } as NodeJS.ProcessEnv,
    );
    expect(m.homeserverUrl).toBe("https://config-hs");
  });
});
