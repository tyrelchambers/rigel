// agent/src/matrixInbound.ts
/**
 * Inbound Matrix: the operator texts the assistant over a Matrix room to diagnose
 * the cluster and approve queued fixes. This module is the pure, testable core —
 * parsing the client-server `/sync` payload, authenticating the sender against an
 * allowlist of Matrix IDs, routing a message to a command, de-duplicating by
 * `event_id`, and chunking replies. All IO (the actual sync/send HTTP, model
 * calls, executor) is injected via handlers, mirroring signalInbound.ts.
 *
 * Security model: only senders on the allowlist are ever acted on; everything
 * else is dropped silently. Free text is a READ-ONLY diagnosis question; the only
 * mutation path is `approve` of an already-vetted, queued suggestion.
 */
export interface MatrixEvent {
  /** Matrix event id — the natural de-dupe key. */
  eventId: string;
  /** Full Matrix user id of the sender, e.g. "@me:hs". */
  sender: string;
  /** The trimmed message body. */
  body: string;
  /** origin_server_ts (ms) — the clock for diagnosis threading. */
  timestamp: number;
}

export interface MatrixSyncResult {
  events: MatrixEvent[];
  /** The `next_batch` cursor to pass as `since` on the following poll. */
  nextBatch: string;
}

/**
 * Parse a `GET /_matrix/client/v3/sync` response: pull `next_batch` and the
 * timeline events for `roomId`. Keeps only `m.room.message` events with a
 * non-empty `m.text` body. Anything malformed is skipped rather than thrown.
 */
export function parseSyncEvents(raw: unknown, roomId: string): MatrixSyncResult {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nextBatch = typeof root["next_batch"] === "string" ? (root["next_batch"] as string) : "";
  const out: MatrixEvent[] = [];
  const rooms = root["rooms"] && typeof root["rooms"] === "object" ? (root["rooms"] as Record<string, unknown>) : undefined;
  const join = rooms?.["join"] && typeof rooms["join"] === "object" ? (rooms["join"] as Record<string, unknown>) : undefined;
  const room = join?.[roomId] && typeof join[roomId] === "object" ? (join[roomId] as Record<string, unknown>) : undefined;
  const timeline = room?.["timeline"] && typeof room["timeline"] === "object" ? (room["timeline"] as Record<string, unknown>) : undefined;
  const events = Array.isArray(timeline?.["events"]) ? (timeline!["events"] as unknown[]) : [];
  for (const e of events) {
    const ev = e && typeof e === "object" ? (e as Record<string, unknown>) : null;
    if (!ev || ev["type"] !== "m.room.message") continue;
    const content = ev["content"] && typeof ev["content"] === "object" ? (ev["content"] as Record<string, unknown>) : undefined;
    if (!content || content["msgtype"] !== "m.text") continue;
    const body = typeof content["body"] === "string" ? (content["body"] as string).trim() : "";
    if (body === "") continue;
    const eventId = typeof ev["event_id"] === "string" ? (ev["event_id"] as string) : "";
    const sender = typeof ev["sender"] === "string" ? (ev["sender"] as string) : "";
    if (!eventId || !sender) continue;
    const timestamp = typeof ev["origin_server_ts"] === "number" ? (ev["origin_server_ts"] as number) : 0;
    out.push({ eventId, sender, body, timestamp });
  }
  return { events: out, nextBatch };
}

/** Is `sender` on the allowlist? Exact match on the trimmed Matrix id. */
export function isAllowedSender(sender: string, allow: string[]): boolean {
  const s = sender.trim();
  if (!s) return false;
  return allow.some((a) => a.trim() === s);
}

/** Bounded set of processed `event_id`s so a redelivered event is never answered
 *  twice. Oldest ids are evicted past the cap. Mirrors signalInbound's
 *  SeenTimestamps, keyed on the Matrix event id instead of (source, timestamp). */
export class SeenEventIds {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly cap = 500) {}
  has(id: string): boolean {
    return this.seen.has(id);
  }
  mark(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.cap) {
      const old = this.order.shift();
      if (old !== undefined) this.seen.delete(old);
    }
  }
}
