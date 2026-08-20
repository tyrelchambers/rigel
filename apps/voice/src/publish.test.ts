import { describe, expect, test, vi } from "vitest";
import { desktopPresent, publishJson, type PublishRoom } from "./publish.js";
import { DESKTOP_IDENTITY } from "./state.js";

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
    const { room, publishData } = fakeRoom([DESKTOP_IDENTITY, "phone-1"]);
    await publishJson(room, "rigel.action", { id: "a1", tier: "voice" });

    expect(publishData).toHaveBeenCalledTimes(1);
    const [data, options] = vi.mocked(publishData).mock.calls[0]!;
    expect(JSON.parse(new TextDecoder().decode(data))).toEqual({ id: "a1", tier: "voice" });
    expect(options).toEqual({
      reliable: true,
      topic: "rigel.action",
      destination_identities: [DESKTOP_IDENTITY],
    });
    expect(options).not.toHaveProperty("destinationIdentities");
  });

  test("a room that never connected has no local participant and publishes nothing", async () => {
    const publishData = vi.fn(async () => {});
    await publishJson({ remoteParticipants: new Map() }, "rigel.action", { id: "a1" });
    expect(publishData).not.toHaveBeenCalled();
  });

  test("a failed publish never propagates into the mutation flow", async () => {
    const publishData = vi.fn(async () => {
      throw new Error("data channel closed");
    });
    const { room } = fakeRoom([DESKTOP_IDENTITY], publishData);
    await expect(publishJson(room, "rigel.action.result", { ok: true })).resolves.toBeUndefined();
  });
});

describe("desktopPresent", () => {
  test("true only when the desktop identity is in the room", () => {
    expect(desktopPresent(fakeRoom([DESKTOP_IDENTITY]).room)).toBe(true);
    expect(desktopPresent(fakeRoom(["phone-1", DESKTOP_IDENTITY]).room)).toBe(true);
    expect(desktopPresent(fakeRoom(["phone-1"]).room)).toBe(false);
    expect(desktopPresent(fakeRoom([]).room)).toBe(false);
  });
});
