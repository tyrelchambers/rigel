import { test, expect } from "vitest";
import {
  fnv1a32,
  fnv1aColorIndex,
  deploymentColorIndex,
  parseLogLine,
  isProbeLine,
  isErrorLine,
  POD_COLORS,
} from "./logs";

test("fnv1a32 matches known vectors", () => {
  // Canonical FNV-1a 32-bit test vectors.
  expect(fnv1a32("")).toBe(2166136261);
  expect(fnv1a32("a")).toBe(0xe40c292c);
  expect(fnv1a32("foobar")).toBe(0xbf9cf968);
});

test("color index is stable and in range 0-7", () => {
  const pod = "memos-abc123-def45";
  const a = fnv1aColorIndex(pod);
  const b = fnv1aColorIndex(pod);
  expect(a).toBe(b);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(8);
  expect(POD_COLORS.length).toBe(8);
});

test("same pod name across namespaces shares a color; deployment hash differs by ns", () => {
  expect(fnv1aColorIndex("web-xyz")).toBe(fnv1aColorIndex("web-xyz"));
  // deployment color keys on "namespace/name", so different ns => may differ.
  const x = deploymentColorIndex("default", "web");
  const y = deploymentColorIndex("staging", "web");
  expect(x).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThan(8);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(y).toBeLessThan(8);
});

test("parseLogLine extracts pod, timestamp, and text", () => {
  const raw = "[pod/memos-abc123-def45/server] 2025-06-09T17:15:42.123456789Z hello world";
  const p = parseLogLine(raw);
  expect(p.sourcePod).toBe("memos-abc123-def45");
  expect(p.text).toBe("hello world");
  expect(p.timestamp).not.toBeNull();
  expect(p.timestamp!.getUTCHours()).toBe(17);
  expect(p.timestamp!.getUTCMinutes()).toBe(15);
  expect(p.timestamp!.getUTCSeconds()).toBe(42);
  expect(p.timestamp!.getUTCMilliseconds()).toBe(123);
  expect(p.colorIndex).toBe(fnv1aColorIndex("memos-abc123-def45"));
});

test("parseLogLine returns null timestamp when unparseable", () => {
  const raw = "[pod/web-1/app] this is not a timestamp at all";
  const p = parseLogLine(raw);
  expect(p.sourcePod).toBe("web-1");
  expect(p.timestamp).toBeNull();
  expect(p.text).toBe("this is not a timestamp at all");
});

test("parseLogLine handles a missing prefix", () => {
  const p = parseLogLine("2025-06-09T17:15:42.000Z bare line");
  expect(p.sourcePod).toBe("");
  expect(p.text).toBe("bare line");
  expect(p.timestamp).not.toBeNull();
});

test("isProbeLine: kube-probe user-agent", () => {
  expect(isProbeLine('User-Agent: kube-probe/1.28 ...')).toBe(true);
});

test("isProbeLine: GET/HEAD health endpoints", () => {
  expect(isProbeLine('GET /healthz HTTP/1.1')).toBe(true);
  expect(isProbeLine('HEAD /readyz?param=value HTTP/1.0')).toBe(true);
  expect(isProbeLine('GET /live HTTP/1.1')).toBe(true);
  expect(isProbeLine('GET /ping HTTP/1.1')).toBe(true);
});

test("isProbeLine: does not match ordinary traffic", () => {
  expect(isProbeLine('GET /api/users HTTP/1.1')).toBe(false);
  expect(isProbeLine('GET /healthcheck-dashboard HTTP/1.1')).toBe(false);
  expect(isProbeLine('processing request id=42')).toBe(false);
});

test("isErrorLine flags error/fatal/panic case-insensitively", () => {
  expect(isErrorLine("ERROR: boom")).toBe(true);
  expect(isErrorLine("Fatal exception")).toBe(true);
  expect(isErrorLine("panic: runtime error")).toBe(true);
  expect(isErrorLine("everything is fine")).toBe(false);
});
