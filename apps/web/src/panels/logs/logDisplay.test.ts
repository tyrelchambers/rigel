import { describe, it, expect } from "vitest";
import {
  toLogLine,
  appendLines,
  filterLines,
  buildLogQuery,
  detectLevel,
  splitHighlight,
  distinctPods,
  distinctContainers,
  sortByTimestamp,
  formatTimestamp,
  podColor,
  deploymentColor,
  deploymentKey,
  sortDeployments,
  replicaText,
  replicasUnhealthy,
  labelSelector,
  lineContext,
  MAX_LINES,
  type LogLine,
} from "./logDisplay";
import type { Deployment } from "../deployments/types";

const dep = (ns: string, name: string, extra: Partial<Deployment> = {}): Deployment => ({
  metadata: { name, namespace: ns, uid: `${ns}/${name}` },
  ...extra,
});

function mkLine(text: string, pod = "web-1"): LogLine {
  return { id: text, sourcePod: pod, timestamp: null, text, colorIndex: 0 };
}

describe("toLogLine", () => {
  it("parses pod/timestamp/text and assigns a unique id", () => {
    const l = toLogLine("[pod/web-abc/app] 2025-06-09T17:15:42.123456789Z hello");
    expect(l.sourcePod).toBe("web-abc");
    expect(l.text).toBe("hello");
    expect(l.timestamp).not.toBeNull();
    expect(l.id).toBeTruthy();
    const l2 = toLogLine("[pod/web-abc/app] 2025-06-09T17:15:42.123456789Z hello");
    expect(l2.id).not.toBe(l.id);
  });
});

describe("appendLines", () => {
  it("appends without mutating and caps at MAX_LINES", () => {
    const base = [mkLine("a")];
    const next = appendLines(base, [mkLine("b")]);
    expect(base.length).toBe(1);
    expect(next.map((l) => l.text)).toEqual(["a", "b"]);

    const big: LogLine[] = Array.from({ length: MAX_LINES }, (_, i) => mkLine(`x${i}`));
    const capped = appendLines(big, [mkLine("new")]);
    expect(capped.length).toBe(MAX_LINES);
    expect(capped[capped.length - 1].text).toBe("new");
    expect(capped[0].text).toBe("x1"); // oldest dropped
  });
});

describe("filterLines", () => {
  const lines = [
    mkLine("GET /healthz HTTP/1.1"),
    mkLine("processing user request"),
    mkLine("User-Agent: kube-probe/1.28"),
    mkLine("ERROR something broke"),
  ];
  const opts = (over: Partial<{ hideProbes: boolean; errorsOnly: boolean; query: string; regex: boolean }> = {}) => ({
    hideProbes: over.hideProbes ?? false,
    errorsOnly: over.errorsOnly ?? false,
    query: buildLogQuery(over.query ?? "", over.regex ?? false),
  });
  it("hides probe noise when hideProbes is on", () => {
    const out = filterLines(lines, opts({ hideProbes: true })).map((l) => l.text);
    expect(out).toEqual(["processing user request", "ERROR something broke"]);
  });
  it("case-insensitive substring filter", () => {
    const out = filterLines(lines, opts({ query: "error" })).map((l) => l.text);
    expect(out).toEqual(["ERROR something broke"]);
  });
  it("applies hideProbes + query together", () => {
    const out = filterLines(lines, opts({ hideProbes: true, query: "request" })).map((l) => l.text);
    expect(out).toEqual(["processing user request"]);
  });
  it("empty filter + everything off returns everything", () => {
    expect(filterLines(lines, opts()).length).toBe(4);
  });
  it("errorsOnly keeps only error/fatal/panic lines", () => {
    const out = filterLines(lines, opts({ errorsOnly: true })).map((l) => l.text);
    expect(out).toEqual(["ERROR something broke"]);
  });
  it("errorsOnly + hideProbes compose (probe error lines would drop, none here)", () => {
    const out = filterLines(lines, opts({ errorsOnly: true, hideProbes: true })).map((l) => l.text);
    expect(out).toEqual(["ERROR something broke"]);
  });
});

describe("sortByTimestamp", () => {
  const at = (text: string, iso: string): LogLine => ({
    id: text,
    sourcePod: "p",
    timestamp: new Date(iso),
    text,
    colorIndex: 0,
  });

  it("merges per-pod batches into one chronological stream", () => {
    // Two replicas' tail batches arrive grouped: podA(early..late), podB(early..late).
    const lines = [
      at("A1", "2026-06-10T16:01:00Z"),
      at("A2", "2026-06-10T16:05:00Z"),
      at("B1", "2026-06-10T16:02:00Z"),
      at("B2", "2026-06-10T16:06:00Z"),
    ];
    expect(sortByTimestamp(lines).map((l) => l.text)).toEqual(["A1", "B1", "A2", "B2"]);
  });

  it("is stable for equal timestamps and pushes null timestamps to the end", () => {
    const lines = [
      at("first", "2026-06-10T16:00:00Z"),
      mkLine("no-ts-1"),
      at("second", "2026-06-10T16:00:00Z"),
      mkLine("no-ts-2"),
    ];
    expect(sortByTimestamp(lines).map((l) => l.text)).toEqual([
      "first",
      "second",
      "no-ts-1",
      "no-ts-2",
    ]);
  });

  it("does not mutate the input array", () => {
    const lines = [at("b", "2026-06-10T16:05:00Z"), at("a", "2026-06-10T16:01:00Z")];
    sortByTimestamp(lines);
    expect(lines.map((l) => l.text)).toEqual(["b", "a"]);
  });
});

describe("formatTimestamp", () => {
  it("formats HH:MM:SS and returns '' for null", () => {
    const d = new Date(2025, 5, 9, 17, 5, 3);
    expect(formatTimestamp(d)).toBe("17:05:03");
    expect(formatTimestamp(null)).toBe("");
  });
});

describe("colors", () => {
  it("pod color is a palette hex and stable", () => {
    expect(podColor("web-1")).toMatch(/^#[0-9A-F]{6}$/i);
    expect(podColor("web-1")).toBe(podColor("web-1"));
  });
  it("deployment color keys on namespace/name", () => {
    expect(deploymentColor("default", "web")).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe("sidebar helpers", () => {
  it("deploymentKey is namespace/name", () => {
    expect(deploymentKey(dep("default", "web"))).toBe("default/web");
  });
  it("sorts by namespace then name", () => {
    const sorted = sortDeployments([
      dep("b", "z"),
      dep("a", "y"),
      dep("a", "x"),
    ]);
    expect(sorted.map(deploymentKey)).toEqual(["a/x", "a/y", "b/z"]);
  });
  it("replicaText and unhealthy", () => {
    const healthy = dep("default", "web", { status: { replicas: 3, readyReplicas: 3 } });
    const sick = dep("default", "api", { status: { replicas: 3, readyReplicas: 1 } });
    expect(replicaText(healthy)).toBe("3/3");
    expect(replicasUnhealthy(healthy)).toBe(false);
    expect(replicaText(sick)).toBe("1/3");
    expect(replicasUnhealthy(sick)).toBe(true);
  });
});

describe("labelSelector", () => {
  it("joins matchLabels sorted by key", () => {
    const d = dep("default", "web", {
      spec: { selector: { matchLabels: { tier: "fe", app: "web" } } },
    });
    expect(labelSelector(d)).toBe("app=web,tier=fe");
  });
  it("returns null when there are no matchLabels", () => {
    expect(labelSelector(dep("default", "web"))).toBeNull();
    expect(labelSelector(dep("default", "web", { spec: { selector: { matchLabels: {} } } }))).toBeNull();
  });
});

describe("lineContext", () => {
  it("returns the line plus 5 before and 5 after (11 max)", () => {
    const lines: LogLine[] = Array.from({ length: 20 }, (_, i) => mkLine(`l${i}`, `p${i}`));
    lines.forEach((l, i) => (l.id = `id${i}`));
    const ctx = lineContext(lines, "id10");
    expect(ctx.length).toBe(11);
    expect(ctx[0].text).toBe("l5");
    expect(ctx[ctx.length - 1].text).toBe("l15");
  });
  it("clamps at the start", () => {
    const lines: LogLine[] = Array.from({ length: 20 }, (_, i) => mkLine(`l${i}`));
    lines.forEach((l, i) => (l.id = `id${i}`));
    const ctx = lineContext(lines, "id1");
    expect(ctx[0].text).toBe("l0");
    expect(ctx.length).toBe(7); // 0..6
  });
});

describe("buildLogQuery", () => {
  it("empty query matches everything with no ranges", () => {
    const q = buildLogQuery("", false);
    expect(q.error).toBeNull();
    expect(q.test("anything")).toBe(true);
    expect(q.ranges("anything")).toEqual([]);
  });
  it("substring is case-insensitive and returns match ranges", () => {
    const q = buildLogQuery("err", false);
    expect(q.test("ERROR here")).toBe(true);
    expect(q.test("clean")).toBe(false);
    expect(q.ranges("ERROR err")).toEqual([[0, 3], [6, 9]]);
  });
  it("regex mode matches and ranges the pattern", () => {
    const q = buildLogQuery("e\\d+", true);
    expect(q.error).toBeNull();
    expect(q.test("code e42 ok")).toBe(true);
    expect(q.ranges("e1 e22")).toEqual([[0, 2], [3, 6]]);
  });
  it("invalid regex sets error and matches nothing", () => {
    const q = buildLogQuery("(", true);
    expect(q.error).not.toBeNull();
    expect(q.test("(")).toBe(false);
    expect(q.ranges("(")).toEqual([]);
  });
});

describe("detectLevel", () => {
  it("detects error/fatal/panic as error", () => {
    expect(detectLevel("ERROR boom")).toBe("error");
    expect(detectLevel("fatal: nope")).toBe("error");
    expect(detectLevel("panic: x")).toBe("error");
  });
  it("detects warn/warning", () => {
    expect(detectLevel("WARN low disk")).toBe("warn");
    expect(detectLevel("warning: deprecated")).toBe("warn");
  });
  it("detects info and debug", () => {
    expect(detectLevel("INFO started")).toBe("info");
    expect(detectLevel("debug here")).toBe("debug");
  });
  it("does not color a /trace URL path as debug", () => {
    expect(detectLevel("GET /api/trace/foo HTTP/1.1")).toBeNull();
  });
  it("returns null when no level token is present", () => {
    expect(detectLevel("just a plain line")).toBeNull();
  });
  it("prioritizes error over lower levels", () => {
    expect(detectLevel("INFO then ERROR")).toBe("error");
  });
});

describe("splitHighlight", () => {
  it("no ranges → one plain segment", () => {
    expect(splitHighlight("hello", [])).toEqual([{ text: "hello", mark: false }]);
  });
  it("one mid-string range → plain/mark/plain", () => {
    expect(splitHighlight("hello", [[1, 3]])).toEqual([
      { text: "h", mark: false },
      { text: "el", mark: true },
      { text: "lo", mark: false },
    ]);
  });
  it("range at start and end", () => {
    expect(splitHighlight("abcd", [[0, 1], [3, 4]])).toEqual([
      { text: "a", mark: true },
      { text: "bc", mark: false },
      { text: "d", mark: true },
    ]);
  });
  it("overlapping ranges are clamped, not duplicated", () => {
    expect(splitHighlight("abcde", [[0, 3], [2, 4]])).toEqual([
      { text: "abc", mark: true },
      { text: "d", mark: true },
      { text: "e", mark: false },
    ]);
  });
  it("a range fully inside an earlier range is subsumed", () => {
    expect(splitHighlight("abcde", [[0, 5], [1, 3]])).toEqual([
      { text: "abcde", mark: true },
    ]);
  });
});

describe("distinctPods", () => {
  it("returns unique pods in first-seen order", () => {
    const ls = [mkLine("a", "p1"), mkLine("b", "p2"), mkLine("c", "p1")];
    expect(distinctPods(ls)).toEqual(["p1", "p2"]);
  });
  it("empty → []", () => {
    expect(distinctPods([])).toEqual([]);
  });
});

describe("toLogLine container", () => {
  it("plumbs the container argument onto the line", () => {
    const l = toLogLine("[pod/web-0/app] 2026-06-09T17:15:42.000Z hi", "app");
    expect(l.container).toBe("app");
    expect(l.text).toBe("hi");
  });
  it("defaults container to empty string when omitted", () => {
    expect(toLogLine("plain line").container).toBe("");
  });
});

describe("distinctContainers", () => {
  it("unique containers in first-seen order, skipping empties", () => {
    const ls = [
      { id: "1", sourcePod: "p", timestamp: null, text: "a", colorIndex: 0, container: "app" },
      { id: "2", sourcePod: "p", timestamp: null, text: "b", colorIndex: 0, container: "sidecar" },
      { id: "3", sourcePod: "p", timestamp: null, text: "c", colorIndex: 0, container: "app" },
      { id: "4", sourcePod: "p", timestamp: null, text: "d", colorIndex: 0, container: "" },
    ];
    expect(distinctContainers(ls)).toEqual(["app", "sidecar"]);
  });
});

describe("filterLines container", () => {
  const ls = [
    { id: "1", sourcePod: "p", timestamp: null, text: "a", colorIndex: 0, container: "app" },
    { id: "2", sourcePod: "p", timestamp: null, text: "b", colorIndex: 0, container: "sidecar" },
  ];
  const base = { hideProbes: false, errorsOnly: false, query: buildLogQuery("", false) };
  it("keeps only the selected container when set", () => {
    expect(filterLines(ls, { ...base, container: "sidecar" }).map((l) => l.text)).toEqual(["b"]);
  });
  it("empty/undefined container keeps everything", () => {
    expect(filterLines(ls, base).length).toBe(2);
  });
});
