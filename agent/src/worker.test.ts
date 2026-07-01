import { describe, expect, test, vi, afterEach } from "vitest";
import { runWorker, parseTriageVerdict } from "./worker.js";
import * as runModelMod from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import type { Incident } from "./detector.js";
import type { ResolvedRepo } from "./repoResolve.js";

function rc(): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false,
    matrix: { homeserverUrl: undefined, userId: undefined, accessToken: undefined, roomId: undefined, allowedSenders: [], inbound: false },
    alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
    autofix: { enabled: false, scope: { projects: [] }, maxPerDay: 5 },
    digests: [],
  } as RuntimeConfig;
}
const INC: Incident = { incidentKind: "unhealthyPod", name: "nginx", namespace: "default", reason: "CrashLoopBackOff" } as Incident;
const REPO: ResolvedRepo = { source: "memos", repoURL: "https://github.com/me/infra", branch: "main", path: "apps/memos" };

afterEach(() => vi.restoreAllMocks());

describe("parseTriageVerdict", () => {
  test("parses a well-formed verdict block", () => {
    const t = parseTriageVerdict('intro ```verdict\n{"verdict":"actionable","reason":"bad image tag"}\n``` outro');
    expect(t).toEqual({ verdict: "actionable", reason: "bad image tag" });
  });

  test("accepts acceptable and uncertain", () => {
    expect(parseTriageVerdict('```verdict\n{"verdict":"acceptable","reason":"benign warning"}\n```').verdict).toBe("acceptable");
    expect(parseTriageVerdict('```verdict\n{"verdict":"uncertain","reason":"unclear"}\n```').verdict).toBe("uncertain");
  });

  test("DEFAULTS to uncertain when there is no verdict block", () => {
    expect(parseTriageVerdict("just prose, no fences at all")).toEqual({ verdict: "uncertain", reason: "" });
  });

  test("DEFAULTS to uncertain on garbled JSON in the block", () => {
    expect(parseTriageVerdict("```verdict\n{not valid json}\n```").verdict).toBe("uncertain");
  });

  test("DEFAULTS to uncertain on an unknown verdict value (never actionable)", () => {
    expect(parseTriageVerdict('```verdict\n{"verdict":"yolo","reason":"x"}\n```').verdict).toBe("uncertain");
  });

  test("DEFAULTS to uncertain when the verdict value is missing or not a string", () => {
    expect(parseTriageVerdict('```verdict\n{"reason":"x"}\n```').verdict).toBe("uncertain");
    expect(parseTriageVerdict('```verdict\n{"verdict":3,"reason":"x"}\n```').verdict).toBe("uncertain");
  });

  test("an unterminated verdict fence does NOT decode (safe default)", () => {
    expect(parseTriageVerdict('```verdict\n{"verdict":"actionable","reason":"x"}').verdict).toBe("uncertain");
  });

  test("is case-insensitive and trims the verdict value", () => {
    expect(parseTriageVerdict('```verdict\n{"verdict":" Actionable ","reason":"x"}\n```').verdict).toBe("actionable");
  });

  test("takes the first valid verdict when several blocks are present", () => {
    expect(
      parseTriageVerdict('```verdict\n{"verdict":"acceptable","reason":"a"}\n```\n```verdict\n{"verdict":"actionable","reason":"b"}\n```').verdict,
    ).toBe("acceptable");
  });

  test("a non-object body defaults to uncertain", () => {
    expect(parseTriageVerdict('```verdict\n"actionable"\n```').verdict).toBe("uncertain");
  });
});

describe("runWorker", () => {
  test("calls runModel as the worker role with the read-only tools + system prompt", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: '```verdict\n{"verdict":"actionable","reason":"crash"}\n```\n```action\n{"label":"restart","kind":"restart","deployment":"nginx","namespace":"default"}\n```',
      costUsd: 0.01, isError: false,
    });
    const out = await runWorker(rc(), [INC]);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ role: "worker" }));
    const call = spy.mock.calls[0]![0];
    expect(call.allowedReads).toContain("Bash(kubectl get *)");
    expect(call.systemPrompt).toMatch(/autonomous/i);
    expect(call.systemPrompt).toMatch(/verdict/i);
    expect(out.actions.length).toBe(1);
    expect(out.actions[0]!.kind).toBe("restart");
    expect(out.verdict).toBe("actionable");
    expect(out.verdictReason).toBe("crash");
    expect(out.failed).toBe(false);
  });

  test("a missing verdict block defaults the output to uncertain (never actionable)", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "no verdict here", costUsd: 0, isError: false });
    const out = await runWorker(rc(), [INC]);
    expect(out.verdict).toBe("uncertain");
  });

  test("a fail-closed runModel result surfaces as a failed output with no actions, verdict uncertain", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: "", costUsd: 0, isError: true, errorMessage: "worker provider gemini has no credential",
    });
    const out = await runWorker(rc(), [INC]);
    expect(out.actions).toEqual([]);
    expect(out.analysis).toMatch(/no credential/);
    expect(out.verdict).toBe("uncertain");
    expect(out.failed).toBe(true);
  });

  test("when a repo is passed, the prompt offers the openFixPR source (autofix-eligible)", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "```verdict\n{\"verdict\":\"uncertain\",\"reason\":\"x\"}\n```", costUsd: 0, isError: false });
    await runWorker(rc(), [INC], REPO);
    const prompt = spy.mock.calls[0]![0].prompt;
    expect(prompt).toMatch(/autofix-eligible/i);
    expect(prompt).toContain("memos");
    expect(prompt).toContain("apps/memos");
  });

  test("with no repo, the prompt states the workload is NOT autofix-eligible", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "```verdict\n{\"verdict\":\"uncertain\",\"reason\":\"x\"}\n```", costUsd: 0, isError: false });
    await runWorker(rc(), [INC], null);
    const prompt = spy.mock.calls[0]![0].prompt;
    expect(prompt).toMatch(/not autofix-eligible/i);
  });
});
