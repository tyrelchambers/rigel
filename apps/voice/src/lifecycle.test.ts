import { EventEmitter } from "node:events";
import { voice } from "@livekit/agents";
import { DisconnectReason } from "@livekit/rtc-node";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AGENT_STATE_TOPIC,
  announceAgentState,
  CLIENT_JOIN_TIMEOUT_MS,
  CLIENT_REJOIN_GRACE_MS,
  superviseSession,
} from "./lifecycle.js";
import type { PublishRoom, VoiceClient } from "./publish.js";

const DESKTOP: VoiceClient = { role: "desktop", clientIdentity: "rigel-desktop" };

type PublishData = NonNullable<PublishRoom["localParticipant"]>["publishData"];

function fakeRoom(publishData: PublishData = vi.fn<PublishData>(async () => {})): {
  room: PublishRoom;
  publishData: PublishData;
} {
  return {
    room: {
      localParticipant: { publishData },
      remoteParticipants: new Map([[DESKTOP.clientIdentity, { identity: DESKTOP.clientIdentity }]]),
    },
    publishData,
  };
}

describe("announceAgentState", () => {
  test("sends the state to the desktop on its own topic", async () => {
    const { room, publishData } = fakeRoom();
    await announceAgentState(room, DESKTOP, "thinking");

    const [data, options] = vi.mocked(publishData).mock.calls[0]!;
    expect(JSON.parse(new TextDecoder().decode(data))).toEqual({ state: "thinking" });
    expect(options).toEqual({
      reliable: true,
      topic: AGENT_STATE_TOPIC,
      destination_identities: [DESKTOP.clientIdentity],
    });
  });

  test("a failed publish never propagates", async () => {
    const { room } = fakeRoom(
      vi.fn<PublishData>(async () => {
        throw new Error("data channel closed");
      }),
    );
    await expect(announceAgentState(room, DESKTOP, "listening")).resolves.toBeUndefined();
  });
});

class FakeRoom extends EventEmitter {
  remoteParticipants = new Map<string, { identity: string }>();
  disconnect = vi.fn(async () => {
    this.emit("disconnected");
  });
  join(identity: string) {
    this.remoteParticipants.set(identity, { identity });
    this.emit("participantConnected", { identity });
  }
  leave(identity: string) {
    this.drop(identity, DisconnectReason.CLIENT_INITIATED);
  }
  drop(identity: string, disconnectReason: DisconnectReason | undefined) {
    this.remoteParticipants.delete(identity);
    this.emit("participantDisconnected", { identity, disconnectReason });
  }
}

class FakeSession extends EventEmitter {
  _closing = false;
  close = vi.fn(async () => {
    this._closing = true;
    await Promise.resolve();
    this.emit(voice.AgentSessionEventTypes.Close, { type: "close" });
  });
  closeItself() {
    this._closing = true;
    this.emit(voice.AgentSessionEventTypes.Close, { type: "close" });
  }
}

const JOB = { room: "rigel-desktop-0a1b2c3d", clientIdentity: "rigel-desktop" };

function supervised(present = true) {
  const room = new FakeRoom();
  if (present) room.remoteParticipants.set(JOB.clientIdentity, { identity: JOB.clientIdentity });
  const session = new FakeSession();
  const sessions = new Map<string, () => Promise<void>>();
  const teardown = superviseSession(sessions, JOB, room, session);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { room, session, sessions, teardown, settle };
}

describe("superviseSession", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("registers the session under its room", () => {
    const { sessions, teardown } = supervised();
    expect(sessions.get(JOB.room)).toBe(teardown);
  });

  test("the client leaving closes the session and leaves the room, once", async () => {
    const { room, session, sessions, settle } = supervised();
    room.leave(JOB.clientIdentity);
    room.leave(JOB.clientIdentity);
    await settle();
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  test("someone other than the client leaving changes nothing", async () => {
    const { room, session, settle } = supervised();
    room.leave("rigel-phone-abc");
    await settle();
    expect(session.close).not.toHaveBeenCalled();
  });

  test("a client that never joins is given up on after the join timeout", async () => {
    vi.useFakeTimers();
    const { room, session, sessions } = supervised(false);
    await vi.advanceTimersByTimeAsync(CLIENT_JOIN_TIMEOUT_MS - 1);
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  test("a client that joins in time keeps the session", async () => {
    vi.useFakeTimers();
    const { room, session } = supervised(false);
    await vi.advanceTimersByTimeAsync(1_000);
    room.join(JOB.clientIdentity);
    await vi.advanceTimersByTimeAsync(CLIENT_JOIN_TIMEOUT_MS);
    expect(session.close).not.toHaveBeenCalled();
  });

  test("the room disconnecting closes the session, once, though leaving fires it again", async () => {
    const { room, session, sessions, settle } = supervised();
    room.emit("disconnected");
    await settle();
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  test("every trigger at once still closes exactly once", async () => {
    vi.useFakeTimers();
    const { room, session, teardown } = supervised(false);
    room.emit("disconnected");
    room.leave(JOB.clientIdentity);
    void teardown();
    await vi.advanceTimersByTimeAsync(CLIENT_JOIN_TIMEOUT_MS);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a close that throws still leaves the room and is never thrown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { room, session, sessions, teardown } = supervised();
    session.close.mockRejectedValueOnce(new Error("already closed"));
    room.disconnect.mockRejectedValueOnce(new Error("not connected"));
    await expect(teardown()).resolves.toBeUndefined();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
  test("a client that drops for any other reason gets the rejoin grace before teardown", async () => {
    vi.useFakeTimers();
    const { room, session, sessions } = supervised();
    room.drop(JOB.clientIdentity, DisconnectReason.SIGNAL_CLOSE);
    await vi.advanceTimersByTimeAsync(CLIENT_REJOIN_GRACE_MS - 1);
    expect(session.close).not.toHaveBeenCalled();
    expect(room.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  test("a leave with no reason reported also gets the grace", async () => {
    vi.useFakeTimers();
    const { room, session } = supervised();
    room.drop(JOB.clientIdentity, undefined);
    await vi.advanceTimersByTimeAsync(CLIENT_REJOIN_GRACE_MS - 1);
    expect(session.close).not.toHaveBeenCalled();
  });

  test("a client that rejoins within the grace keeps the session", async () => {
    vi.useFakeTimers();
    const { room, session } = supervised();
    room.drop(JOB.clientIdentity, DisconnectReason.STATE_MISMATCH);
    await vi.advanceTimersByTimeAsync(5_000);
    room.join(JOB.clientIdentity);
    await vi.advanceTimersByTimeAsync(CLIENT_REJOIN_GRACE_MS + CLIENT_JOIN_TIMEOUT_MS);
    expect(session.close).not.toHaveBeenCalled();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  test("the old connection kicked for a duplicate identity after the rejoin keeps the session", async () => {
    vi.useFakeTimers();
    const { room, session } = supervised();
    room.join(JOB.clientIdentity);
    room.drop(JOB.clientIdentity, DisconnectReason.DUPLICATE_IDENTITY);
    await vi.advanceTimersByTimeAsync(CLIENT_REJOIN_GRACE_MS + CLIENT_JOIN_TIMEOUT_MS);
    expect(session.close).not.toHaveBeenCalled();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  test("a duplicate-identity kick during a grace leaves that grace running", async () => {
    vi.useFakeTimers();
    const { room, session } = supervised();
    room.drop(JOB.clientIdentity, DisconnectReason.SIGNAL_CLOSE);
    room.drop(JOB.clientIdentity, DisconnectReason.DUPLICATE_IDENTITY);
    await vi.advanceTimersByTimeAsync(CLIENT_REJOIN_GRACE_MS - 1);
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test("a drop after teardown began arms no grace timer", async () => {
    vi.useFakeTimers();
    const { room, teardown } = supervised();
    void teardown();
    room.drop(JOB.clientIdentity, DisconnectReason.SIGNAL_CLOSE);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("someone else joining during the grace does not cancel it", async () => {
    vi.useFakeTimers();
    const { room, session } = supervised();
    room.drop(JOB.clientIdentity, DisconnectReason.SIGNAL_CLOSE);
    room.join("rigel-phone-abc");
    await vi.advanceTimersByTimeAsync(CLIENT_REJOIN_GRACE_MS);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test("a closing click after a dropped connection tears down at once, and only once", async () => {
    vi.useFakeTimers();
    const { room, session } = supervised();
    room.drop(JOB.clientIdentity, DisconnectReason.SIGNAL_CLOSE);
    room.join(JOB.clientIdentity);
    room.leave(JOB.clientIdentity);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CLIENT_REJOIN_GRACE_MS + CLIENT_JOIN_TIMEOUT_MS);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
  });

  test("the room disconnecting during the grace tears down once, and the grace never fires again", async () => {
    vi.useFakeTimers();
    const { room, session } = supervised();
    room.drop(JOB.clientIdentity, DisconnectReason.SIGNAL_CLOSE);
    room.emit("disconnected");
    await vi.advanceTimersByTimeAsync(CLIENT_REJOIN_GRACE_MS);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a session that closes itself leaves the room without being closed again", async () => {
    const { room, session, sessions, settle } = supervised();
    session.closeItself();
    await settle();
    expect(session.close).not.toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  test("the Close our own teardown causes does not start a second teardown", async () => {
    const { room, session, teardown } = supervised();
    await teardown();
    expect(session.listenerCount(voice.AgentSessionEventTypes.Close)).toBe(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a session already closing when the client leaves is not closed again", async () => {
    const { room, session, settle } = supervised();
    session._closing = true;
    room.leave(JOB.clientIdentity);
    await settle();
    expect(session.close).not.toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
  });
});
