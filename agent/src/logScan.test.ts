import { describe, expect, test } from "vitest";
import { scanLogsForErrors } from "./logScan.js";

const GO_PANIC = [
  "2026-06-29T10:00:00Z INFO serving on :8080",
  "panic: runtime error: index out of range [3] with length 2",
  "",
  "goroutine 17 [running]:",
  "main.handle(0xc000123abc, 0x42)",
  "\t/app/main.go:88 +0x1a5",
].join("\n");

const PYTHON_TRACEBACK = [
  "INFO worker started",
  "Traceback (most recent call last):",
  '  File "/app/main.py", line 42, in <module>',
  '    raise ValueError("bad config")',
  "ValueError: bad config",
].join("\n");

const NODE_UNCAUGHT = [
  "info: listening",
  "Uncaught Error: cannot read property 'id' of undefined",
  "    at Object.<anonymous> (/app/index.js:10:11)",
  "    at Module._compile (node:internal/modules/cjs/loader:1234:14)",
].join("\n");

const FATAL_LINE = [
  "2026-06-29T10:00:00.123Z INFO ready",
  "2026-06-29T10:00:01.456Z FATAL could not connect to database: connection refused",
].join("\n");

const ERROR_BURST = [
  "INFO starting",
  "ERROR failed to process job 1001",
  "ERROR failed to process job 1002",
  "ERROR failed to process job 1003",
  "ERROR failed to process job 1004",
  "ERROR failed to process job 1005",
].join("\n");

const HEALTHY = [
  "INFO server started on :8080",
  "INFO handled request GET / 200",
  "INFO handled request GET /healthz 200",
  "DEBUG cache warm complete",
].join("\n");

const LONE_ERROR = [
  "INFO starting",
  "ERROR transient blip talking to upstream, retrying",
  "INFO recovered, continuing",
].join("\n");

describe("scanLogsForErrors — positives", () => {
  const positives: Array<[string, string]> = [
    ["go panic", GO_PANIC],
    ["python traceback", PYTHON_TRACEBACK],
    ["node uncaught exception", NODE_UNCAUGHT],
    ["fatal log line", FATAL_LINE],
    ["repeated ERROR burst", ERROR_BURST],
  ];

  test.each(positives)("matches %s with a non-empty signature", (_name, log) => {
    const res = scanLogsForErrors(log);
    expect(res.matched).toBe(true);
    expect(res.signature).toBeTruthy();
    expect(res.reason).toBeTruthy();
  });
});

describe("scanLogsForErrors — negatives", () => {
  const negatives: Array<[string, string]> = [
    ["healthy info logs", HEALTHY],
    ["a single one-off ERROR line", LONE_ERROR],
    ["two ERROR lines (below burst threshold)", ["ERROR a 1", "ERROR a 2"].join("\n")],
    ["empty log text", ""],
    ["whitespace-only log text", "   \n  \n"],
  ];

  test.each(negatives)("does NOT match %s", (_name, log) => {
    const res = scanLogsForErrors(log);
    expect(res.matched).toBe(false);
    expect(res.signature).toBeUndefined();
  });
});

describe("scanLogsForErrors — signature stability (dedup)", () => {
  test("same panic with different addresses/goroutines/indices collapses to one signature", () => {
    const a = scanLogsForErrors(GO_PANIC);
    const b = scanLogsForErrors(
      [
        "panic: runtime error: index out of range [7] with length 5",
        "goroutine 99 [running]:",
        "main.handle(0xdeadbeef, 0x99)",
        "\t/app/main.go:88 +0x9f1",
      ].join("\n"),
    );
    expect(a.signature).toBe(b.signature);
  });

  test("same error burst with different ids collapses to one signature", () => {
    const a = scanLogsForErrors(ERROR_BURST);
    const b = scanLogsForErrors(
      [
        "ERROR failed to process job 9991",
        "ERROR failed to process job 9992",
        "ERROR failed to process job 9993",
      ].join("\n"),
    );
    expect(a.signature).toBe(b.signature);
  });

  test("same fatal with different timestamps collapses to one signature", () => {
    const a = scanLogsForErrors(FATAL_LINE);
    const b = scanLogsForErrors(
      "1999-01-01T00:00:00.000Z FATAL could not connect to database: connection refused",
    );
    expect(a.signature).toBe(b.signature);
  });

  test("different error classes produce different signatures", () => {
    const panic = scanLogsForErrors(GO_PANIC).signature;
    const trace = scanLogsForErrors(PYTHON_TRACEBACK).signature;
    expect(panic).not.toBe(trace);
  });
});
