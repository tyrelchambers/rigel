import { describe, expect, test } from "vitest";
import { chatFeedback, visibleSummary, batchFeedback } from "./workloadResultReport";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr: string) => ({ code, stdout: "", stderr });

describe("chatFeedback (model-facing, mirrors Swift WorkloadResultReport)", () => {
  test("success: header, command echo, status, output", () => {
    const msg = chatFeedback("kubectl --context default get pods", ok("pod/a\npod/b"));
    expect(msg).toContain("[Rigel executed the action you proposed — the user approved it.]");
    expect(msg).toContain("kubectl --context default get pods");
    expect(msg).toContain("Status: success");
    expect(msg).toContain("pod/a\npod/b");
  });

  test("success with empty output uses (no output)", () => {
    expect(chatFeedback("kubectl delete pod x", ok("   "))).toContain("(no output)");
  });

  test("failure: failed header, exit code, stderr, (no stderr) fallback", () => {
    const msg = chatFeedback("kubectl delete svc postgres", fail(1, "Error: not found"));
    expect(msg).toContain("FAILED");
    expect(msg).toContain("Exit code: 1");
    expect(msg).toContain("Error: not found");
    expect(chatFeedback("kubectl delete svc x", fail(2, ""))).toContain("(no stderr)");
  });

  test("clips output at 4000 chars", () => {
    const big = "x".repeat(5000);
    const msg = chatFeedback("kubectl get pods", ok(big));
    expect(msg).toContain("…(truncated)");
    expect(msg).not.toContain("x".repeat(4001));
  });
});

describe("visibleSummary (the ✓/✗ system bubble)", () => {
  test("success shows ✓ and output, or 'ok' when empty", () => {
    expect(visibleSummary("Restart memos", ok("deployment restarted"))).toBe(
      "✓ Restart memos — deployment restarted",
    );
    expect(visibleSummary("Restart memos", ok(""))).toBe("✓ Restart memos — ok");
  });

  test("failure shows ✗, exit code and stderr", () => {
    expect(visibleSummary("Delete svc postgres", fail(1, "forbidden"))).toBe(
      "✗ Delete svc postgres failed (exit 1):\nforbidden",
    );
  });
});

describe("batchFeedback (mirrors Swift WorkloadResultReport.batchFeedback)", () => {
  test("all success: header + per-action success lines + continue close, no skipped section", () => {
    const msg = batchFeedback(
      [
        { commandString: "kubectl scale deploy/a --replicas=2", result: ok("scaled") },
        { commandString: "kubectl rollout restart deploy/b", result: ok("") },
      ],
      [],
    );
    expect(msg).toContain("[Rigel ran a queue of actions you proposed — the user approved and ran them together.]");
    expect(msg).toContain("• success: kubectl scale deploy/a --replicas=2\n  output: scaled");
    expect(msg).toContain("• success: kubectl rollout restart deploy/b\n  output: (no output)");
    expect(msg).not.toContain("NOT run");
    expect(msg).toContain("Continue the task");
  });

  test("mid-failure: FAILED line, skipped section, and diagnose close", () => {
    const msg = batchFeedback(
      [
        { commandString: "kubectl scale deploy/a --replicas=2", result: ok("scaled") },
        { commandString: "kubectl delete svc postgres", result: fail(1, "forbidden") },
      ],
      ["kubectl rollout restart deploy/c"],
    );
    expect(msg).toContain("• success: kubectl scale deploy/a --replicas=2");
    expect(msg).toContain("• FAILED (exit 1): kubectl delete svc postgres\n  error: forbidden");
    expect(msg).toContain("Stopped after a failure — these queued actions were NOT run:");
    expect(msg).toContain("• kubectl rollout restart deploy/c");
    expect(msg).toContain("Diagnose the failure");
    expect(msg).not.toContain("Continue the task");
  });

  test("empty stderr on failure falls back to (no stderr)", () => {
    expect(batchFeedback([{ commandString: "kubectl x", result: fail(2, "") }], [])).toContain("(no stderr)");
  });
});
