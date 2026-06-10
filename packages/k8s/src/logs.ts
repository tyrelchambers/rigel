// Shared log-stream logic for the Logs panel — used by BOTH the server (Bun,
// when spawning `kubectl logs`) and the web app (TS, when rendering lines).
// Mirrors the Swift LogLine / PodColorAssigner / LogLineParser / LogNoiseFilter
// in Sources/Helmsman/. See docs/parity/logs.md for the normative spec.

/** A single parsed log line. `id` is assigned by the consumer (per instance). */
export interface ParsedLogLine {
  sourcePod: string;
  timestamp: Date | null;
  text: string;
  colorIndex: number; // 0-7
}

/**
 * The 8-color pod palette (hex). Index is `fnv1aColorIndex(podName)`.
 * Order is part of the contract — do not reorder.
 */
export const POD_COLORS: readonly string[] = [
  "#60A5FA", // blue
  "#34D399", // green
  "#FB923C", // orange
  "#A855F7", // purple
  "#EC4899", // pink
  "#22D3EE", // cyan
  "#FACC15", // yellow
  "#2DD4BF", // teal
];

/**
 * FNV-1a 32-bit hash of a string, returned as an unsigned 32-bit integer.
 * Deterministic and stable across restarts/processes.
 */
export function fnv1a32(s: string): number {
  let hash = 2166136261;
  // Hash the UTF-8 bytes so multibyte pod names match the Swift implementation.
  const bytes = utf8Bytes(s);
  for (const byte of bytes) {
    hash ^= byte;
    // Multiply by the FNV prime 16777619, keeping 32-bit unsigned via Math.imul.
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** UTF-8 byte values for a string (no TextEncoder dependency, works in Bun + DOM). */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — combine with the following low surrogate.
      const hi = code;
      const lo = s.charCodeAt(++i);
      code = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out;
}

/** Stable color index (0-7) for a pod name via FNV-1a. */
export function fnv1aColorIndex(podName: string): number {
  return fnv1a32(podName) % 8;
}

/** Color index (0-7) for a sidebar deployment row, keyed on "namespace/name". */
export function deploymentColorIndex(namespace: string, name: string): number {
  return fnv1a32(`${namespace}/${name}`) % 8;
}

// kubectl --prefix=true emits `[pod/<name>/<container>] ` before each line.
const PREFIX_RE = /^\[pod\/([^/\]]+)\/[^\]]+\]\s+/;

/**
 * Parse one raw kubectl-logs line (with `--prefix=true --timestamps`) into its
 * pod/timestamp/text parts plus a stable color index.
 *
 * Format: `[pod/<pod>/<container>] <ISO8601-timestamp> <message>`
 * - Pod name extracted via PREFIX_RE; if the prefix is absent, sourcePod = "".
 * - The first whitespace-delimited token after the prefix is parsed as an
 *   ISO8601 timestamp (with fractional seconds). If it parses, it becomes
 *   `timestamp` and the remainder is `text`; otherwise `timestamp` is null and
 *   the whole remainder (prefix stripped) is `text`.
 */
export function parseLogLine(raw: string): ParsedLogLine {
  let sourcePod = "";
  let rest = raw;

  const m = PREFIX_RE.exec(raw);
  if (m) {
    sourcePod = m[1];
    rest = raw.slice(m[0].length);
  }

  let timestamp: Date | null = null;
  let text = rest;

  // First token up to the first space is the candidate timestamp.
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx > 0) {
    const candidate = rest.slice(0, spaceIdx);
    const d = parseIso8601(candidate);
    if (d) {
      timestamp = d;
      text = rest.slice(spaceIdx + 1);
    }
  }

  return { sourcePod, timestamp, text, colorIndex: fnv1aColorIndex(sourcePod) };
}

// ISO8601 with optional fractional seconds and a trailing Z/offset. kubectl
// emits nanosecond precision (e.g. 2025-06-09T17:15:42.123456789Z), which
// Date.parse does not accept, so validate the shape ourselves then truncate to
// milliseconds before parsing.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function parseIso8601(s: string): Date | null {
  if (!ISO_RE.test(s)) return null;
  // Truncate fractional seconds to 3 digits (milliseconds) for Date.parse.
  const normalized = s.replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : new Date(t);
}

// --- Probe-noise filter (shared predicate) ---------------------------------

// Pattern 1: User-Agent / line contains "kube-probe".
const KUBE_PROBE_RE = /kube-probe/;
// Pattern 2: GET|HEAD request to a health/readiness endpoint.
const HEALTH_ENDPOINT_RE =
  /(?:GET|HEAD)\s+\/(?:healthz|health|readyz|ready|livez|live|ping)(?:\s|\?|"|$)/;

/**
 * True when a log line is high-frequency kubelet/health-check noise:
 *   1. contains "kube-probe" (probe User-Agent), or
 *   2. is a GET/HEAD to /healthz|/health|/readyz|/ready|/livez|/live|/ping.
 * Shared verbatim by the server and web so both hide the same lines.
 */
export function isProbeLine(text: string): boolean {
  return KUBE_PROBE_RE.test(text) || HEALTH_ENDPOINT_RE.test(text);
}

/** True when a line should be highlighted red (contains error/fatal/panic). */
export function isErrorLine(text: string): boolean {
  return /error|fatal|panic/i.test(text);
}
