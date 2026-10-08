import { describe, expect, test, vi } from "vitest";
import { desktopPresent, publishJson, type PublishRoom, type VoiceClient } from "./publish.js";

const DESKTOP: VoiceClient = { role: "desktop", clientIdentity: "rigel-desktop" };

type PublishData = NonNullable<PublishRoom["localParticipant"]>["publishData"];

function fakeRoom(
  identities: string[],
  publishData: PublishData = vi.fn<PublishData>(async () => {}),
): { room: PublishRoom; publishData: PublishData } {
  return {
    room: {
      localParticipant: { publishData },
      remoteParticipants: new Map(identities.map((identity) => [identity, { identity }])),
    },
    publishData,
  };
}

describe("publishJson", () => {
  test("sends reliable, snake_case destinations, and targets only the desktop", async () => {
    const { room, publishData } = fakeRoom([DESKTOP.clientIdentity, "phone-1"]);
    await publishJson(room, DESKTOP, "rigel.action", { id: "a1", tier: "voice" });

    expect(publishData).toHaveBeenCalledTimes(1);
    const [data, options] = vi.mocked(publishData).mock.calls[0]!;
    expect(JSON.parse(new TextDecoder().decode(data))).toEqual({ id: "a1", tier: "voice" });
    expect(options).toEqual({
      reliable: true,
      topic: "rigel.action",
      destination_identities: [DESKTOP.clientIdentity],
    });
    expect(options).not.toHaveProperty("destinationIdentities");
  });

  test("a room that never connected has no local participant and publishes nothing", async () => {
    const publishData = vi.fn(async () => {});
    await publishJson({ remoteParticipants: new Map() }, DESKTOP, "rigel.action", { id: "a1" });
    expect(publishData).not.toHaveBeenCalled();
  });

  test("a failed publish never propagates into the mutation flow", async () => {
    const publishData = vi.fn(async () => {
      throw new Error("data channel closed");
    });
    const { room } = fakeRoom([DESKTOP.clientIdentity], publishData);
    await expect(publishJson(room, DESKTOP, "rigel.action.result", { ok: true })).resolves.toBeUndefined();
  });
});

describe("publishJson destinations", () => {
  test("targets whichever client the room was made for", async () => {
    const phone: VoiceClient = { role: "phone", clientIdentity: "rigel-phone-abc" };
    const { room, publishData } = fakeRoom([phone.clientIdentity]);
    await publishJson(room, phone, "rigel.agent.state", { state: "listening" });
    expect(vi.mocked(publishData).mock.calls[0]![1].destination_identities).toEqual([phone.clientIdentity]);
  });
});

describe("desktopPresent", () => {
  test("never true in a phone room, even with the phone connected", () => {
    const phone: VoiceClient = { role: "phone", clientIdentity: "rigel-phone-abc" };
    expect(desktopPresent(fakeRoom([phone.clientIdentity]).room, phone)).toBe(false);
  });

  test("true only when the desktop identity is in the room", () => {
    expect(desktopPresent(fakeRoom([DESKTOP.clientIdentity]).room, DESKTOP)).toBe(true);
    expect(desktopPresent(fakeRoom(["phone-1", DESKTOP.clientIdentity]).room, DESKTOP)).toBe(true);
    expect(desktopPresent(fakeRoom(["phone-1"]).room, DESKTOP)).toBe(false);
    expect(desktopPresent(fakeRoom([]).room, DESKTOP)).toBe(false);
  });
});
