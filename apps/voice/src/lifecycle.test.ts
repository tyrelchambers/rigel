import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AGENT_STATE_TOPIC, announceAgentState, CLIENT_JOIN_TIMEOUT_MS, superviseSession } from "./lifecycle.js";
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
    this.remoteParticipants.delete(identity);
    this.emit("participantDisconnected", { identity });
  }
}

const JOB = { room: "rigel-desktop-0a1b2c3d", clientIdentity: "rigel-desktop" };

function supervised(present = true) {
  const room = new FakeRoom();
  if (present) room.remoteParticipants.set(JOB.clientIdentity, { identity: JOB.clientIdentity });
  const session = { close: vi.fn(async () => {}) };
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
});
