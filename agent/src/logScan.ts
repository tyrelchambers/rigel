/**
 * Bounded, dependency-free scan of a chunk of recent pod log output for app-level
 * error signatures. This is the trigger for the "logs errors but never crashes"
 * class of incident: the status checks in detector.ts never fire for these pods,
 * so without this they go unnoticed.
 *
 * Noise control is the whole game. A single stray ERROR line is NOT a match (apps
 * log transient errors all the time); we only fire on a hard fault signature
 * (panic / fatal / stack trace / unhandled exception) or a SUSTAINED burst of the
 * same ERROR-level line. The returned `signature` is normalized — volatile bits
 * (timestamps, hex/pointers, ids, numbers) are stripped — so the same recurring
 * error fingerprints identically across ticks and collapses to one incident.
 */
export interface LogScanResult {
  matched: boolean;
  /** Stable, normalized fingerprint of the matched error (absent when no match). */
  signature?: string;
  /** Short human-readable explanation of why it matched (absent when no match). */
  reason?: string;
}

/** The same normalized ERROR-level line must recur at least this many times to
 * fire as a "burst" — a lone (or one-off) ERROR is treated as noise. */
const ERROR_BURST_THRESHOLD = 3;

/** Defensive ceiling on lines scanned; the caller already bounds via `--tail`. */
const MAX_LINES = 4000;

/** Keep signatures bounded so a pathological log line can't bloat the fingerprint. */
const MAX_SIGNATURE = 160;

interface Signature {
  signature: string;
  reason: string;
}

export function scanLogsForErrors(logText: string): LogScanResult {
  const text = logText ?? "";
  if (text.trim() === "") return { matched: false };
  const lines = text.split(/\r?\n/).slice(0, MAX_LINES);

  // 1. Hard fault signatures fire on a single occurrence — they mean a real fault.
  const hard = matchHardSignature(lines);
  if (hard) return { matched: true, signature: hard.signature, reason: hard.reason };

  // 2. Otherwise require a repeated ERROR-level burst (a single ERROR is ignored).
  const burst = matchErrorBurst(lines);
  if (burst) return { matched: true, signature: burst.signature, reason: burst.reason };

  return { matched: false };
}

/** Normalize a log line into a stable key by stripping volatile content. Order
 * matters: timestamps (which contain digits/`:`/`-`) and structured tokens are
 * removed before the catch-all digit pass. */
function normalize(line: string): string {
  return line
    // ISO-8601 timestamps (with optional millis + zone)
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "")
    // hex / pointers / addresses
    .replace(/\b0x[0-9a-fA-F]+\b/g, "0x?")
    // UUIDs
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "?")
    // any remaining bare numbers (ids, line numbers, counts)
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sig(category: string, keyLine: string): Signature {
  const key = normalize(keyLine);
  return {
    signature: `${category}:${key}`.slice(0, MAX_SIGNATURE),
    reason: `${category}: ${truncate(keyLine.trim(), 200)}`,
  };
}

/** A stack-frame line, used both to confirm a real trace and to avoid picking a
 * frame as the (less stable) signature title. */
function isFrame(raw: string): boolean {
  return (
    /^\s+at\s+\S/.test(raw) || // JS / Java / .NET
    /^\s*File\s+".*",\s+line\s+\d+/.test(raw) || // Python
    /^goroutine\s+\d+\s+\[/.test(raw) || // Go
    /^\s+\/.*\.go:\d+/.test(raw) // Go frame file:line
  );
}

function matchHardSignature(lines: string[]): Signature | null {
  let sawFrame = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^panic:/i.test(line)) return sig("panic", line);
    if (/\bFATAL\b/.test(raw)) return sig("fatal", line);
    if (
      /\b(uncaught|unhandled)\s+(exception|error|promise\s+rejection|rejection)\b/i.test(line) ||
      /\bUnhandledPromiseRejection\b/.test(line)
    ) {
      return sig("unhandled", line);
    }
    if (isFrame(raw)) sawFrame = true;
  }
  // A stack trace is present (>=1 frame): anchor the signature on the exception
  // type line if we can find one, so it stays stable across differing frames.
  if (sawFrame) {
    const title = exceptionTitle(lines);
    return sig("stacktrace", title ?? "stack trace");
  }
  return null;
}

/** The most stable "title" line of a stack trace: prefer the canonical
 * `Type: message` form (Python/Java/JS), else any CamelCase exception token. */
function exceptionTitle(lines: string[]): string | null {
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[\w.$]+(?:Error|Exception)\b\s*:/.test(line)) return line;
  }
  for (const raw of lines) {
    if (isFrame(raw)) continue;
    const line = raw.trim();
    if (/\b[A-Z][\w.$]*(?:Error|Exception)\b/.test(line)) return line;
  }
  return null;
}

/** True for a log line carrying ERROR severity (the common all-caps level, or a
 * structured `level=error` / `"level":"error"`). Case-sensitive on `ERROR` so the
 * word "error" inside prose / an exception class name isn't counted. */
function isErrorLevel(line: string): boolean {
  return (
    /\bERROR\b/.test(line) ||
    /\blevel\s*=\s*"?error"?/i.test(line) ||
    /"level"\s*:\s*"error"/i.test(line)
  );
}

function matchErrorBurst(lines: string[]): Signature | null {
  const groups = new Map<string, { count: number; sample: string }>();
  for (const raw of lines) {
    if (!isErrorLevel(raw)) continue;
    const key = normalize(raw);
    if (key === "") continue;
    const g = groups.get(key) ?? { count: 0, sample: raw.trim() };
    g.count += 1;
    groups.set(key, g);
  }
  let best: { key: string; count: number; sample: string } | null = null;
  for (const [key, g] of groups) {
    if (best === null || g.count > best.count) best = { key, ...g };
  }
  if (best && best.count >= ERROR_BURST_THRESHOLD) {
    return {
      signature: `error-burst:${best.key}`.slice(0, MAX_SIGNATURE),
      reason: `${best.count} repeated ERROR-level lines: ${truncate(best.sample, 200)}`,
    };
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
