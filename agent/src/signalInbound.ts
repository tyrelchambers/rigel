/**
 * Inbound Signal: lets the operator text the assistant to run the cluster. This
 * module is the pure, testable core — parsing the signal-cli-rest-api receive
 * payload, authenticating the sender against an allowlist, de-duplicating
 * already-seen messages, and chunking replies for the phone. All IO (the actual
 * receive/send HTTP, the agent turn) is injected via handlers so the loop is
 * deterministic and unit-tested.
 *
 * There is NO deterministic command parsing: every authorized message is one
 * conversational, act-capable agent turn. The model reads intent — "why is x
 * down?", "restart the api", "yes go ahead" all just flow to the agent, which
 * investigates and makes reversible changes directly. A destructive change is
 * proposed in prose first and only runs once the operator confirms in their own
 * words. In every case the agent's RBAC is the hard ceiling on what it can touch.
 *
 * Security model: only senders on the allowlist (the operator's own linked
 * number by default) are ever acted on; everything else is dropped silently.
 */

export interface IncomingMessage {
  /** E.164 sender number, best-effort from the envelope. */
  source: string;
  /** Signal message timestamp (ms) — the natural de-dupe key. */
  timestamp: number;
  text: string;
}

/** Strip spacing/formatting so "+1 (555) 010-1234" matches "+15550101234". */
export function normalizeNumber(s: string): string {
  return s.replace(/[\s()\-.]/g, "");
}

/** Is `source` on the allowlist? Compares normalized E.164 numbers. */
export function isAuthorized(source: string, allow: string[]): boolean {
  if (!source) return false;
  const me = normalizeNumber(source);
  return allow.some((a) => normalizeNumber(a) === me);
}

/**
 * Parse the array returned by `GET /v1/receive/{number}`. Each element carries
 * an `envelope`; we keep entries that carry message text in either a
 * `dataMessage` (a message sent to us by someone else) or a
 * `syncMessage.sentMessage` (a message the account sent from another device —
 * e.g. texting your own number / "Note to Self", which is how send-to-self
 * arrives on a linked signal-cli device). Receipts, typing indicators, and
 * empty messages are skipped. Defensive against shape drift — anything
 * malformed is skipped rather than thrown.
 */
export function parseReceived(raw: unknown): IncomingMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: IncomingMessage[] = [];
  for (const entry of raw) {
    const env = (entry as Record<string, unknown> | null)?.["envelope"] as
      | Record<string, unknown>
      | undefined;
    if (!env || typeof env !== "object") continue;
    const dm = env["dataMessage"] as Record<string, unknown> | undefined;
    const sm = (env["syncMessage"] as Record<string, unknown> | undefined)?.["sentMessage"] as
      | Record<string, unknown>
      | undefined;
    const msg = dm ?? sm; // dataMessage takes priority; both should never be set
    const text = msg && typeof msg["message"] === "string" ? (msg["message"] as string) : "";
    if (text.trim() === "") continue; // receipt / typing / empty — ignore
    const sourceNumber = typeof env["sourceNumber"] === "string" ? (env["sourceNumber"] as string) : "";
    const source = sourceNumber || (typeof env["source"] === "string" ? (env["source"] as string) : "");
    if (!source) continue;
    const timestamp =
      typeof msg?.["timestamp"] === "number"
        ? (msg["timestamp"] as number)
        : typeof env["timestamp"] === "number"
          ? (env["timestamp"] as number)
          : 0;
    out.push({ source, timestamp, text: text.trim() });
  }
  return out;
}

/**
 * Split a reply into Signal-sized chunks, preferring to break on a newline or
 * space near the limit. Numbers chunks `(i/n)` when there is more than one.
 */
export function chunkText(s: string, max = 1400): string[] {
  const text = s.trim();
  if (text.length === 0) return [];
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  const total = chunks.length;
  return chunks.map((c, i) => (total > 1 ? `(${i + 1}/${total}) ${c}` : c));
}

/** Bounded set of processed (source, timestamp) keys so a redelivered message
 * is never answered twice. Oldest keys are evicted past the cap. */
export class SeenTimestamps {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly cap = 500) {}
  private key(source: string, ts: number): string {
    return `${source}:${ts}`;
  }
  has(source: string, ts: number): boolean {
    return this.seen.has(this.key(source, ts));
  }
  mark(source: string, ts: number): void {
    const k = this.key(source, ts);
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.order.push(k);
    if (this.order.length > this.cap) {
      const old = this.order.shift();
      if (old !== undefined) this.seen.delete(old);
    }
  }
}

export interface InboundContext {
  /** Whether inbound command handling is turned on (the kill-switch, `rc.enabled`). */
  enabled: boolean;
  apiUrl?: string;
  number?: string;
  /** Authorized sender numbers (the operator's own number by default). */
  allow: string[];
}

/** The transport-agnostic message surface: one conversational, act-capable agent
 *  turn. Shared verbatim by the Signal and Matrix inbound loops — the model reads
 *  intent, so there are no separate command handlers. */
export interface MessageHandler {
  /** Handle one inbound message (threaded per `source`): investigate, make
   *  reversible changes, run a confirmed destructive action through the guard,
   *  and return the reply text. */
  respond(text: string, source: string, timestamp: number): Promise<string>;
  log?(msg: string): void;
}

export interface InboundHandlers extends MessageHandler {
  receive(apiUrl: string, number: string): Promise<unknown>;
  reply(recipient: string, text: string): Promise<void>;
}

/** Run one message through the agent, turning a throw into an error reply. */
export async function respondSafely(
  h: MessageHandler,
  text: string,
  source: string,
  timestamp: number,
): Promise<string> {
  try {
    return await h.respond(text, source, timestamp);
  } catch (e) {
    return `Sorry — that failed: ${String(e)}`;
  }
}

/**
 * One inbound poll: fetch pending messages, drop anything unauthorized or
 * already handled, run each through the agent, and reply (chunked). Never
 * throws — a failure handling one message becomes an error reply, and a receive
 * failure is logged and skipped, so inbound never disturbs the remediation loop.
 */
export async function handleInbound(
  ctx: InboundContext,
  h: InboundHandlers,
  seen: SeenTimestamps,
): Promise<void> {
  if (!ctx.enabled || !ctx.apiUrl || !ctx.number) return;
  let raw: unknown;
  try {
    raw = await h.receive(ctx.apiUrl, ctx.number);
  } catch (e) {
    h.log?.(`signal receive failed: ${String(e)}`);
    return;
  }
  for (const msg of parseReceived(raw)) {
    if (seen.has(msg.source, msg.timestamp)) continue;
    seen.mark(msg.source, msg.timestamp);
    if (!isAuthorized(msg.source, ctx.allow)) {
      h.log?.(`signal: ignoring message from unauthorized sender ${msg.source}`);
      continue;
    }
    h.log?.(`signal: message from ${msg.source}`);
    const reply = await respondSafely(h, msg.text, msg.source, msg.timestamp);
    for (const chunk of chunkText(reply)) {
      await h.reply(msg.source, chunk);
    }
  }
}
