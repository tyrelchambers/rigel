// agent/src/matrixInbound.ts
import { respondSafely, chunkText, type MessageHandler } from "./signalInbound.js";
/**
 * Inbound Matrix: the operator runs the cluster by texting the bot over Matrix
 * rooms. This is the pure, testable core — parsing the client-server `/sync`
 * payload across ALL joined rooms, discovering invites, authenticating senders
 * against an allowlist of Matrix ids, de-duplicating by `event_id`, and chunking
 * replies. All IO (sync/send HTTP, join, the agent turn) is injected, mirroring
 * signalInbound.ts.
 *
 * One durable conversation thread per room: each event carries its `roomId`,
 * which is used both as the reply target and as the session thread key. The bot
 * auto-joins any room it is invited to by an allowlisted user, so a new topic is
 * started by creating a room and inviting the bot. `/reset` starts that room's
 * thread fresh. There is NO deterministic command parsing otherwise: every
 * authorized message is one conversational, act-capable agent turn.
 */
export interface MatrixEvent {
  /** Matrix event id — the natural de-dupe key. */
  eventId: string;
  /** Full Matrix user id of the sender, e.g. "@me:hs". */
  sender: string;
  /** The trimmed message body. */
  body: string;
  /** origin_server_ts (ms) — the clock for session threading. */
  timestamp: number;
  /** The room this event arrived in — reply target and per-room thread key. */
  roomId: string;
}

/** A pending invite the bot has received but not yet joined. */
export interface MatrixInvite {
  /** The invited room id. */
  roomId: string;
  /** Full Matrix id of whoever sent the invite (gated against the allowlist). */
  inviter: string;
}

export interface MatrixSyncResult {
  events: MatrixEvent[];
  invites: MatrixInvite[];
  /** The `next_batch` cursor to pass as `since` on the following poll. */
  nextBatch: string;
}

/**
 * Parse a `GET /_matrix/client/v3/sync` response: `next_batch`, the timeline
 * `m.room.message`/`m.text` events across every joined room (each tagged with
 * its room id), and pending invites (each with its inviter). Anything malformed
 * is skipped rather than thrown.
 */
export function parseSyncEvents(raw: unknown): MatrixSyncResult {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nextBatch = typeof root["next_batch"] === "string" ? (root["next_batch"] as string) : "";
  const out: MatrixEvent[] = [];
  const invites: MatrixInvite[] = [];
  const rooms = root["rooms"] && typeof root["rooms"] === "object" ? (root["rooms"] as Record<string, unknown>) : undefined;

  const join = rooms?.["join"] && typeof rooms["join"] === "object" ? (rooms["join"] as Record<string, unknown>) : undefined;
  if (join) {
    for (const [roomId, roomValue] of Object.entries(join)) {
      const room = roomValue && typeof roomValue === "object" ? (roomValue as Record<string, unknown>) : undefined;
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
        out.push({ eventId, sender, body, timestamp, roomId });
      }
    }
  }

  const invite = rooms?.["invite"] && typeof rooms["invite"] === "object" ? (rooms["invite"] as Record<string, unknown>) : undefined;
  if (invite) {
    for (const [roomId, roomValue] of Object.entries(invite)) {
      const room = roomValue && typeof roomValue === "object" ? (roomValue as Record<string, unknown>) : undefined;
      const inviteState = room?.["invite_state"] && typeof room["invite_state"] === "object" ? (room["invite_state"] as Record<string, unknown>) : undefined;
      const events = Array.isArray(inviteState?.["events"]) ? (inviteState!["events"] as unknown[]) : [];
      let inviter = "";
      for (const e of events) {
        const ev = e && typeof e === "object" ? (e as Record<string, unknown>) : null;
        if (!ev || ev["type"] !== "m.room.member") continue;
        const content = ev["content"] && typeof ev["content"] === "object" ? (ev["content"] as Record<string, unknown>) : undefined;
        if (content?.["membership"] !== "invite") continue;
        inviter = typeof ev["sender"] === "string" ? (ev["sender"] as string) : "";
        if (inviter) break;
      }
      invites.push({ roomId, inviter });
    }
  }

  return { events: out, invites, nextBatch };
}

/** Is `sender` on the allowlist? Exact match on the trimmed Matrix id. */
export function isAllowedSender(sender: string, allow: string[]): boolean {
  const s = sender.trim();
  if (!s) return false;
  return allow.some((a) => a.trim() === s);
}

/** Bounded set of processed `event_id`s so a redelivered event is never answered
 *  twice. Oldest ids are evicted past the cap. */
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

export interface MatrixInboundContext {
  /** Whether inbound command handling is turned on. */
  enabled: boolean;
  homeserverUrl?: string;
  accessToken?: string;
  /** Authorized sender Matrix ids (also gates who may invite the bot). */
  allow: string[];
  /** The bot's own Matrix id, so its own sent messages are never processed. */
  botUserId?: string;
  /** The `since` cursor from the last poll (undefined on first run). */
  since?: string;
}

export interface MatrixInboundHandlers extends MessageHandler {
  /** GET /_matrix/client/v3/sync with the stored cursor; returns the parsed body. */
  sync(since: string | undefined): Promise<unknown>;
  /** PUT a reply into `roomId`. */
  reply(roomId: string, text: string): Promise<void>;
  /** POST a read receipt for `eventId` in `roomId` (best-effort). */
  markRead(roomId: string, eventId: string): Promise<void>;
  /** PUT a typing notification into `roomId` (best-effort). */
  setTyping(roomId: string, typing: boolean): Promise<void>;
  /** Join `roomId` after an allowlisted invite (best-effort). */
  join(roomId: string): Promise<void>;
  /** Forget `roomId`'s session so its next message starts a fresh thread. */
  resetThread(roomId: string): Promise<void>;
}

/**
 * One inbound poll: sync from the cursor, auto-join allowlisted invites, then
 * for each fresh authorized message route it to its room's thread (or handle
 * `/reset`) and reply into that room. Never throws — a handler failure becomes an
 * error reply and a sync failure keeps the prior cursor. Returns the new `since`
 * cursor to persist (the prior cursor on a failed sync).
 */
export async function handleMatrixInbound(
  ctx: MatrixInboundContext,
  h: MatrixInboundHandlers,
  seen: SeenEventIds,
): Promise<string | undefined> {
  if (!ctx.enabled || !ctx.homeserverUrl || !ctx.accessToken) return ctx.since;
  let raw: unknown;
  try {
    raw = await h.sync(ctx.since);
  } catch (e) {
    h.log?.(`matrix sync failed: ${String(e)}`);
    return ctx.since;
  }
  const { events, invites, nextBatch } = parseSyncEvents(raw);

  for (const inv of invites) {
    if (!isAllowedSender(inv.inviter, ctx.allow)) {
      h.log?.(`matrix: ignoring invite to ${inv.roomId} from unauthorized ${inv.inviter}`);
      continue;
    }
    try {
      await h.join(inv.roomId);
      h.log?.(`matrix: joined ${inv.roomId} (invited by ${inv.inviter})`);
    } catch (e) {
      h.log?.(`matrix: join ${inv.roomId} failed: ${String(e)}`);
    }
  }

  for (const ev of events) {
    if (seen.has(ev.eventId)) continue;
    seen.mark(ev.eventId);
    if (ctx.botUserId && ev.sender === ctx.botUserId) continue;
    if (!isAllowedSender(ev.sender, ctx.allow)) {
      h.log?.(`matrix: ignoring message from unauthorized sender ${ev.sender}`);
      continue;
    }
    await h.markRead(ev.roomId, ev.eventId);
    if (ev.body === "/reset") {
      await h.resetThread(ev.roomId);
      await h.reply(ev.roomId, "Started a fresh thread in this room.");
      continue;
    }
    await h.setTyping(ev.roomId, true);
    h.log?.(`matrix: message from ${ev.sender} in ${ev.roomId}`);
    const reply = await respondSafely(h, ev.body, ev.sender, ev.timestamp, ev.roomId);
    for (const chunk of chunkText(reply)) {
      await h.reply(ev.roomId, chunk);
    }
    await h.setTyping(ev.roomId, false);
  }
  return nextBatch || ctx.since;
}
