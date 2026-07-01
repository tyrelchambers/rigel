import { describe, expect, it, test } from "vitest";
import {
  appendAudit,
  autoSilence,
  capBackups,
  countFixPrBudget,
  dispositionFromAudit,
  emptyState,
  reconcileQueue,
  recordIncident,
  recordPullRequest,
  resolveFixAudit,
  resolveIncident,
  touchIncident,
  type AssistantState,
  type AuditEntry,
  type PullRequestRecord,
  type QueuedSuggestion,
} from "./state.js";

function entry(at: string, fingerprint: string): AuditEntry {
  return {
    at,
    fingerprint,
    incident: "x",
    tier: "low",
    outcome: "success",
    detail: "",
  };
}

describe("appendAudit", () => {
  test("prepends the newest entry (newest first)", () => {
    const s1 = appendAudit(emptyState(), entry("2026-05-29T01:00:00Z", "a"), 50);
    const s2 = appendAudit(s1, entry("2026-05-29T02:00:00Z", "b"), 50);
    expect(s2.audit.map((e) => e.fingerprint)).toEqual(["b", "a"]);
  });

  test("caps the log at maxEntries, dropping the oldest", () => {
    let s = emptyState();
    for (let i = 0; i < 10; i++) s = appendAudit(s, entry(`t${i}`, `fp${i}`), 3);
    expect(s.audit).toHaveLength(3);
    expect(s.audit.map((e) => e.fingerprint)).toEqual(["fp9", "fp8", "fp7"]);
  });

  test("stamps updatedAt from the appended entry", () => {
    const s = appendAudit(emptyState(), entry("2026-05-29T03:00:00Z", "a"), 50);
    expect(s.updatedAt).toBe("2026-05-29T03:00:00Z");
  });

  test("does not mutate the input state", () => {
    const before = emptyState();
    appendAudit(before, entry("t", "a"), 50);
    expect(before.audit).toEqual([]);
  });
});

describe("autoSilence", () => {
  test("adds a fingerprint, newest-first", () => {
    const s = autoSilence(autoSilence(emptyState(), "a"), "b");
    expect(s.autoSilenced).toEqual(["b", "a"]);
  });

  test("is a no-op (does not reorder) when the fingerprint is already silenced", () => {
    const s1 = autoSilence(autoSilence(emptyState(), "a"), "b");
    const s2 = autoSilence(s1, "a");
    expect(s2.autoSilenced).toEqual(["b", "a"]);
    expect(s2).toBe(s1); // same reference — no new state when nothing changed
  });

  test("caps the list, dropping the oldest", () => {
    let s = emptyState();
    for (let i = 0; i < 5; i++) s = autoSilence(s, `fp${i}`, 3);
    expect(s.autoSilenced).toEqual(["fp4", "fp3", "fp2"]);
  });

  test("does not mutate the input state", () => {
    const before = emptyState();
    autoSilence(before, "a");
    expect(before.autoSilenced).toBeUndefined();
  });
});

describe("recordPullRequest", () => {
  function pr(over: Partial<PullRequestRecord> = {}): PullRequestRecord {
    return {
      at: "2026-06-30T12:00:00Z", fingerprint: "fp", filePath: "a.yaml", incident: "i",
      app: "memos", repo: "https://github.com/me/infra", branch: "rigel/fix", prUrl: "https://x/pull/1",
      title: "t", summary: "", status: "open", kind: "config", ...over,
    };
  }

  test("adds a record newest-first and reports added", () => {
    const r1 = recordPullRequest(emptyState(), pr({ prUrl: "https://x/pull/1" }));
    const r2 = recordPullRequest(r1.state, pr({ fingerprint: "fp2", prUrl: "https://x/pull/2" }));
    expect(r2.added).toBe(true);
    expect(r2.state.pullRequests!.map((p) => p.prUrl)).toEqual(["https://x/pull/2", "https://x/pull/1"]);
  });

  test("dedups on fingerprint+filePath (no double-record), reports added=false", () => {
    const r1 = recordPullRequest(emptyState(), pr());
    const r2 = recordPullRequest(r1.state, pr({ prUrl: "https://x/pull/999" }));
    expect(r2.added).toBe(false);
    expect(r2.state.pullRequests).toHaveLength(1);
    expect(r2.state).toBe(r1.state); // unchanged reference
  });

  test("same fingerprint but a DIFFERENT file is a distinct record", () => {
    const r1 = recordPullRequest(emptyState(), pr({ filePath: "a.yaml" }));
    const r2 = recordPullRequest(r1.state, pr({ filePath: "b.yaml" }));
    expect(r2.added).toBe(true);
    expect(r2.state.pullRequests).toHaveLength(2);
  });

  test("caps the list, dropping the oldest", () => {
    let s = emptyState();
    for (let i = 0; i < 5; i++) s = recordPullRequest(s, pr({ fingerprint: `fp${i}` }), 3).state;
    expect(s.pullRequests).toHaveLength(3);
    expect(s.pullRequests!.map((p) => p.fingerprint)).toEqual(["fp4", "fp3", "fp2"]);
  });

  test("does not mutate the input state", () => {
    const before = emptyState();
    recordPullRequest(before, pr());
    expect(before.pullRequests).toBeUndefined();
  });
});

describe("countFixPrBudget", () => {
  const NOW = Date.parse("2026-06-30T12:00:00Z");
  const DAY = 24 * 3_600_000;
  function rec(over: Partial<PullRequestRecord>): PullRequestRecord {
    return {
      at: new Date(NOW).toISOString(), fingerprint: "fp", filePath: "a.yaml", incident: "i",
      app: "memos", repo: "https://github.com/me/infra", title: "t", summary: "",
      status: "open", kind: "config", ...over,
    };
  }

  test("counts only OPEN records inside the 24h window", () => {
    const prs = [
      rec({ status: "open", at: new Date(NOW - 1000).toISOString() }), // in window
      rec({ status: "failed", at: new Date(NOW - 1000).toISOString() }), // not an opened PR
      rec({ status: "open", at: new Date(NOW - DAY - 1000).toISOString() }), // aged out
    ];
    expect(countFixPrBudget(prs, 0, NOW)).toBe(1);
  });

  test("adds the in-flight Job count to the recorded-open count", () => {
    expect(countFixPrBudget([rec({ status: "open" })], 2, NOW)).toBe(3);
  });

  test("a record exactly at the window edge still counts (>= since)", () => {
    expect(countFixPrBudget([rec({ status: "open", at: new Date(NOW - DAY).toISOString() })], 0, NOW)).toBe(1);
  });

  test("a record aging just past the window frees its slot", () => {
    expect(countFixPrBudget([rec({ status: "open", at: new Date(NOW - DAY - 1).toISOString() })], 0, NOW)).toBe(0);
  });

  test("an unparsable `at` is dropped (not counted)", () => {
    expect(countFixPrBudget([rec({ status: "open", at: "not-a-date" })], 0, NOW)).toBe(0);
  });

  test("undefined / empty pullRequests with no in-flight is 0", () => {
    expect(countFixPrBudget(undefined, 0, NOW)).toBe(0);
    expect(countFixPrBudget([], 0, NOW)).toBe(0);
  });
});

describe("resolveFixAudit", () => {
  const terminal: AuditEntry = {
    at: "2026-06-30T12:00:00Z", fingerprint: "fp", incident: "i", proposal: "Open fix PR",
    tier: "medium", outcome: "success", detail: "Rigel opened a fix PR: https://x/pull/1",
  };

  function pending(over: Partial<AuditEntry> = {}): AuditEntry {
    return { at: "t", fingerprint: "fp", incident: "i", proposal: "Open fix PR", tier: "medium", outcome: "queued", detail: "pending the fix-runner", ...over };
  }

  test("replaces the matching pending entry in place (no growth)", () => {
    const s = appendAudit(emptyState(), pending(), 200);
    const out = resolveFixAudit(s, "fp", "Open fix PR", terminal, 200);
    expect(out.audit).toHaveLength(1);
    expect(out.audit[0]).toBe(terminal);
  });

  test("prepends when no pending entry exists (e.g. rotated out)", () => {
    const out = resolveFixAudit(emptyState(), "fp", "Open fix PR", terminal, 200);
    expect(out.audit).toEqual([terminal]);
  });

  test("never matches an ESCALATED entry (it carries a verdict)", () => {
    const escalated = pending({ verdict: "escalated", detail: "Opus escalated the fix" });
    const s = appendAudit(emptyState(), escalated, 200);
    const out = resolveFixAudit(s, "fp", "Open fix PR", terminal, 200);
    // The escalated entry is left intact; the terminal is prepended.
    expect(out.audit).toHaveLength(2);
    expect(out.audit[0]).toBe(terminal);
    expect(out.audit[1]).toBe(escalated);
  });
});

describe("capBackups", () => {
  test("keeps the newest N keys (timestamp-prefixed sort) and drops the oldest", () => {
    const data = { "2026-01-01_a": "1", "2026-01-02_b": "2", "2026-01-03_c": "3" };
    expect(capBackups(data, 2)).toEqual({ "2026-01-02_b": "2", "2026-01-03_c": "3" });
  });

  test("returns the data unchanged when under the cap", () => {
    const data = { "2026-01-01_a": "1" };
    expect(capBackups(data, 5)).toEqual(data);
  });

  test("a cap of zero drops everything", () => {
    expect(capBackups({ "2026-01-01_a": "1" }, 0)).toEqual({});
  });
});

const empty = (): AssistantState => ({ updatedAt: "", audit: [], queue: [], report: "" });

describe("recordIncident", () => {
  it("prepends a new record", () => {
    const s = recordIncident(empty(), {
      at: "t1", lastSeenAt: "t1", fingerprint: "unhealthyPod|ns|p|x",
      location: "ns/p", reason: "x", disposition: "flagged",
    }, 300);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents![0]!.fingerprint).toBe("unhealthyPod|ns|p|x");
  });
  it("upserts an open record by fingerprint (refresh, no dup)", () => {
    let s = recordIncident(empty(), { at: "t1", lastSeenAt: "t1", fingerprint: "fp", location: "l", reason: "r", disposition: "flagged" }, 300);
    s = recordIncident(s, { at: "t2", lastSeenAt: "t2", fingerprint: "fp", location: "l", reason: "r", disposition: "autoFixed" }, 300);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents![0]!.disposition).toBe("autoFixed");
    expect(s.incidents![0]!.at).toBe("t1");        // first-seen preserved
    expect(s.incidents![0]!.lastSeenAt).toBe("t2"); // refreshed
  });
  it("caps the list", () => {
    let s = empty();
    for (let i = 0; i < 5; i++) s = recordIncident(s, { at: `t${i}`, lastSeenAt: `t${i}`, fingerprint: `fp${i}`, location: "l", reason: "r", disposition: "flagged" }, 3);
    expect(s.incidents).toHaveLength(3);
  });
});

describe("touchIncident", () => {
  it("creates a flagged record when absent", () => {
    const s = touchIncident(empty(), { at: "t1", lastSeenAt: "t1", fingerprint: "fp", location: "l", reason: "r" }, 300);
    expect(s.incidents![0]!.disposition).toBe("flagged");
  });
  it("refreshes lastSeenAt but NEVER downgrades an existing disposition", () => {
    let s = recordIncident(empty(), { at: "t1", lastSeenAt: "t1", fingerprint: "fp", location: "l", reason: "r", disposition: "autoFixed" }, 300);
    s = touchIncident(s, { at: "t2", lastSeenAt: "t2", fingerprint: "fp", location: "l", reason: "r" }, 300);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents![0]!.disposition).toBe("autoFixed"); // not downgraded to flagged
    expect(s.incidents![0]!.lastSeenAt).toBe("t2");
  });
});

describe("resolveIncident", () => {
  it("marks the open record resolved", () => {
    let s = recordIncident(empty(), { at: "t1", lastSeenAt: "t1", fingerprint: "fp", location: "l", reason: "r", disposition: "flagged" }, 300);
    s = resolveIncident(s, "fp", "t9");
    expect(s.incidents![0]!.disposition).toBe("resolved");
    expect(s.incidents![0]!.resolvedAt).toBe("t9");
  });
});

describe("dispositionFromAudit", () => {
  it("maps outcomes", () => {
    expect(dispositionFromAudit({ at: "", fingerprint: "", incident: "", tier: "low", outcome: "success", detail: "" })).toBe("autoFixed");
    expect(dispositionFromAudit({ at: "", fingerprint: "", incident: "", tier: "low", outcome: "queued", detail: "" })).toBe("queued");
    expect(dispositionFromAudit({ at: "", fingerprint: "", incident: "", tier: "low", outcome: "failure", detail: "" })).toBe("failed");
    expect(dispositionFromAudit({ at: "", fingerprint: "", incident: "", tier: "low", outcome: "skipped", detail: "" })).toBe("flagged");
  });
});

describe("reconcileQueue", () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-06-19T12:00:00Z");
  const TTL = 48 * HOUR;

  function q(over: Partial<QueuedSuggestion>): QueuedSuggestion {
    return { at: "2026-06-19T11:00:00Z", incident: "i", suggestion: "s", reason: "r", ...over };
  }

  const bothKinds = new Set(["unhealthyPod", "degradedDeployment"]);

  test("keeps an item whose incident is still present", () => {
    const item = q({ fingerprint: "unhealthyPod|default|web|CrashLoopBackOff" });
    const r = reconcileQueue([item], new Set([item.fingerprint!]), bothKinds, NOW, TTL);
    expect(r.kept).toEqual([item]);
    expect(r.cleared).toEqual([]);
  });

  test("clears an item whose incident cleared and whose kind was checked", () => {
    const item = q({ fingerprint: "unhealthyPod|default|web|CrashLoopBackOff" });
    const r = reconcileQueue([item], new Set(), bothKinds, NOW, TTL);
    expect(r.kept).toEqual([]);
    expect(r.cleared).toHaveLength(1);
    expect(r.cleared[0]!.reason).toMatch(/no longer present/);
  });

  test("does NOT clear when detection for that kind did not run this tick", () => {
    const item = q({ fingerprint: "degradedDeployment|default|api|Degraded" });
    // Only pods were checked; the deployment detection didn't run → can't confirm.
    const r = reconcileQueue([item], new Set(), new Set(["unhealthyPod"]), NOW, TTL);
    expect(r.kept).toEqual([item]);
    expect(r.cleared).toEqual([]);
  });

  test("TTL backstop clears an unverifiable item older than the TTL", () => {
    const old = q({ fingerprint: "degradedDeployment|default|api|Degraded", at: "2026-06-16T11:00:00Z" });
    const r = reconcileQueue([old], new Set(), new Set(["unhealthyPod"]), NOW, TTL);
    expect(r.kept).toEqual([]);
    expect(r.cleared[0]!.reason).toMatch(/stale/);
  });

  test("keeps a legacy item without a fingerprint until the TTL", () => {
    const recent = q({ at: "2026-06-19T11:00:00Z" }); // no fingerprint, recent
    const old = q({ at: "2026-06-16T11:00:00Z" }); // no fingerprint, stale
    const r = reconcileQueue([recent, old], new Set(), bothKinds, NOW, TTL);
    expect(r.kept).toEqual([recent]);
    expect(r.cleared).toHaveLength(1);
    expect(r.cleared[0]!.item).toBe(old);
  });
});
