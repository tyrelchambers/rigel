import { describe, expect, test } from "vitest";
import { chatFeedback, visibleSummary } from "./workloadResultReport";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr: string) => ({ code, stdout: "", stderr });

describe("chatFeedback (model-facing, mirrors Swift WorkloadResultReport)", () => {
  test("success: header, command echo, status, output", () => {
    const msg = chatFeedback("kubectl --context default get pods", ok("pod/a\npod/b"));
    expect(msg).toContain("[Helmsman executed the action you proposed — the user approved it.]");
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
