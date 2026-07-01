// agent/src/digest.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => vi.clearAllMocks());
import { isDigestDue, assembleDigestData, renderDigestText } from "./digest.js";
import type { DigestSubscription } from "@rigel/k8s/src/digest.js";
import type { AssistantState } from "./state.js";

const sub = (over: Partial<DigestSubscription> = {}): DigestSubscription => ({
  id: "a", enabled: true, label: "M", channel: "signal",
  days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", timezone: "America/Toronto",
  lookback: { mode: "sinceLast" }, createdAt: "", ...over,
});

// 2026-06-30 is a Tuesday. EDT = UTC-4 in summer.
const at = (iso: string) => Date.parse(iso);

describe("isDigestDue", () => {
  it("fires when now has crossed today's slot and lastSent was before it", () => {
    // armed yesterday; now is 07:00 EDT = 11:00 UTC
    expect(isDigestDue(sub(), "2026-06-29T11:00:00.000Z", at("2026-06-30T11:00:00.000Z"))).toBe(true);
  });
  it("does not fire before the slot", () => {
    // now is 06:30 EDT = 10:30 UTC
    expect(isDigestDue(sub(), "2026-06-29T11:00:00.000Z", at("2026-06-30T10:30:00.000Z"))).toBe(false);
  });
  it("does not re-fire after sending for this slot", () => {
    expect(isDigestDue(sub(), "2026-06-30T11:00:05.000Z", at("2026-06-30T11:01:00.000Z"))).toBe(false);
  });
  it("skips days not in the schedule", () => {
    // Wednesday-only sub on a Tuesday: the most-recent slot is last Wednesday
    // (2026-06-24 07:00 EDT = 11:00 UTC), already sent → no re-fire on a Tuesday.
    expect(isDigestDue(sub({ days: [3] }), "2026-06-24T11:00:05.000Z", at("2026-06-30T12:00:00.000Z"))).toBe(false);
  });
  it("is disabled-aware", () => {
    expect(isDigestDue(sub({ enabled: false }), "2026-06-29T11:00:00.000Z", at("2026-06-30T11:00:00.000Z"))).toBe(false);
  });
  it("handles DST fall-back without double-firing", () => {
    // 2026-11-01 02:00 EDT->EST fall-back. A 01:30 slot occurs; lastSent just after it must block re-fire.
    const s = sub({ time: "01:30", timezone: "America/Toronto" });
    // first 01:30 EDT = 05:30 UTC; sent at 05:30:05 UTC
    expect(isDigestDue(s, "2026-11-01T05:30:05.000Z", at("2026-11-01T06:45:00.000Z"))).toBe(false);
  });
});

// ---- Task 9 fixtures ----

const state = (): AssistantState => ({
  updatedAt: "", audit: [], queue: [
    { at: "2026-06-30T03:00:00.000Z", incident: "x pending", suggestion: "kubectl ...", reason: "RBAC" },
  ], report: "",
  incidents: [
    { at: "2026-06-30T02:00:00.000Z", lastSeenAt: "2026-06-30T02:05:00.000Z", fingerprint: "unhealthyPod|prod|api|CrashLoopBackOff", location: "prod/api", reason: "CrashLoopBackOff", disposition: "autoFixed" },
    { at: "2026-06-29T10:00:00.000Z", lastSeenAt: "2026-06-29T10:00:00.000Z", fingerprint: "old|x|y|z", location: "x/y", reason: "z", disposition: "resolved" }, // before window
  ],
  pullRequests: [
    { at: "2026-06-30T02:10:00.000Z", fingerprint: "unhealthyPod|prod|api|CrashLoopBackOff", filePath: "k8s/api.yaml", incident: "api crashloop", app: "prod/api", repo: "r", title: "fix api", summary: "patched", status: "open", kind: "config" },
  ],
});

const detection = { pods: [{}, {}, {}], deps: [{}], incidents: [] };

describe("assembleDigestData", () => {
  it("windows incidents + PRs by `at` (fixed lookback)", () => {
    const now = Date.parse("2026-06-30T07:00:00.000Z");
    const s = { id: "a", enabled: true, label: "M", channel: "signal" as const, days: [2], time: "07:00", timezone: "UTC", lookback: { mode: "fixed" as const, hours: 8 }, createdAt: "" };
    const data = assembleDigestData(state(), detection, s, now, undefined);
    expect(data.incidents).toHaveLength(1);            // the autoFixed one; the day-old one is out
    expect(data.pullRequests).toHaveLength(1);
    expect(data.queueCount).toBe(1);
    expect(data.health).toEqual({ totalPods: 3, totalDeployments: 1, currentIncidents: 0 });
  });
  it("sinceLast uses lastSentAt as the window start", () => {
    const now = Date.parse("2026-06-30T07:00:00.000Z");
    const s = { id: "a", enabled: true, label: "M", channel: "signal" as const, days: [2], time: "07:00", timezone: "UTC", lookback: { mode: "sinceLast" as const }, createdAt: "" };
    const data = assembleDigestData(state(), detection, s, now, "2026-06-30T01:00:00.000Z");
    expect(data.incidents).toHaveLength(1);
  });
});

describe("renderDigestText", () => {
  it("produces a deterministic body mentioning the counts", () => {
    const now = Date.parse("2026-06-30T07:00:00.000Z");
    const s = { id: "a", enabled: true, label: "Morning digest", channel: "signal" as const, days: [2], time: "07:00", timezone: "UTC", lookback: { mode: "fixed" as const, hours: 8 }, createdAt: "" };
    const text = renderDigestText(assembleDigestData(state(), detection, s, now, undefined));
    expect(text).toContain("Morning digest");
    expect(text).toContain("1 incident");
    expect(text).toContain("1 fix PR");
    expect(text).toContain("api");
  });
});

// ---- Task 10: composeDigestMessage ----
import * as runModelMod from "./runModel.js";
import { composeDigestMessage } from "./digest.js";

const rc = { worker: { provider: "claude", model: "m" }, supervisor: { provider: "claude", model: "m" } } as any;

const dataFixture = () => {
  const now = Date.parse("2026-06-30T07:00:00.000Z");
  const s = { id: "a", enabled: true, label: "Morning digest", channel: "signal" as const, days: [2], time: "07:00", timezone: "UTC", lookback: { mode: "fixed" as const, hours: 8 }, createdAt: "" };
  return assembleDigestData(state(), detection, s, now, undefined);
};

describe("composeDigestMessage", () => {
  it("prepends the AI headline on success", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ isError: false, text: "A quiet night, one fix landed.", costUsd: 0, sessionId: "" } as any);
    const text = await composeDigestMessage(rc, dataFixture());
    expect(text.startsWith("A quiet night, one fix landed.")).toBe(true);
    expect(text).toContain("Morning digest"); // body still present
  });
  it("falls back to the body alone on model error", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ isError: true, errorMessage: "no credential", text: "", costUsd: 0 } as any);
    const text = await composeDigestMessage(rc, dataFixture());
    expect(text).toContain("Morning digest");
    expect(text).not.toContain("undefined");
  });
});

// ---- Task 11: evaluateDigests ----
import * as notify from "./notify.js";
import { evaluateDigests } from "./digest.js";

const rcWith = (over: any) => ({
  worker: { provider: "claude", model: "m" }, supervisor: { provider: "claude", model: "m" },
  webhookUrl: undefined, signalApiUrl: "http://sig", signalNumber: "+1", signalRecipients: ["+2"],
  matrix: {}, digests: [], digestRunNow: undefined, ...over,
}) as any;

const dueSub = { id: "a", enabled: true, label: "M", channel: "signal" as const, days: [0,1,2,3,4,5,6], time: "07:00", timezone: "UTC", lookback: { mode: "sinceLast" as const }, createdAt: "" };

describe("evaluateDigests", () => {
  it("arms a new subscription without sending", async () => {
    const sig = vi.spyOn(notify, "notifySignal").mockResolvedValue();
    const now = Date.parse("2026-06-30T07:00:30.000Z");
    const s = await evaluateDigests(rcWith({ digests: [dueSub] }), state(), detection, now);
    expect(sig).not.toHaveBeenCalled();
    expect(s.digestState?.lastSentAt.a).toBeDefined();
  });
  it("sends when due (armed) and stamps lastSentAt", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ isError: false, text: "head", costUsd: 0, sessionId: "" } as any);
    const sig = vi.spyOn(notify, "notifySignal").mockResolvedValue();
    const now = Date.parse("2026-06-30T11:00:30.000Z"); // 07:00 EDT? UTC tz here so 11:00 is past 07:00
    let st = state();
    st = { ...st, digestState: { lastSentAt: { a: "2026-06-29T07:00:00.000Z" } } };
    const s = await evaluateDigests(rcWith({ digests: [dueSub] }), st, detection, now);
    expect(sig).toHaveBeenCalledTimes(1);
    expect(s.digestState?.lastSentAt.a).toBe(new Date(now).toISOString());
  });
  it("runs a fresh run-now preview token without sending or touching lastSentAt", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ isError: false, text: "head", costUsd: 0, sessionId: "" } as any);
    const sig = vi.spyOn(notify, "notifySignal").mockResolvedValue();
    const now = Date.parse("2026-06-30T11:00:30.000Z");
    let st = state();
    st = { ...st, digestState: { lastSentAt: { a: "2026-06-30T11:00:00.000Z" } } };
    const rc = rcWith({ digests: [dueSub], digestRunNow: { id: "a", mode: "preview", token: "tok-1" } });
    const s = await evaluateDigests(rc, st, detection, now);
    expect(sig).not.toHaveBeenCalled();
    expect(s.digestState?.lastPreview?.text).toContain("M");
    expect(s.digestState?.lastRunNowToken).toBe("tok-1");
    expect(s.digestState?.lastSentAt.a).toBe("2026-06-30T11:00:00.000Z"); // unchanged
  });
  it("ignores a stale run-now token", async () => {
    const sig = vi.spyOn(notify, "notifySignal").mockResolvedValue();
    const now = Date.parse("2026-06-30T11:00:30.000Z");
    let st = state();
    st = { ...st, digestState: { lastSentAt: { a: new Date(now).toISOString() }, lastRunNowToken: "tok-1" } };
    const rc = rcWith({ digests: [dueSub], digestRunNow: { id: "a", mode: "send", token: "tok-1" } });
    const s = await evaluateDigests(rc, st, detection, now);
    expect(sig).not.toHaveBeenCalled();
  });
});
