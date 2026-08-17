// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Room } from "livekit-client";
import { useCluster } from "@/store/cluster";
import { publishJson, VoiceSessionEffects } from "./VoiceSessionEffects";

function fakeRoom() {
  return { localParticipant: { publishData: vi.fn() } } as unknown as Room;
}

function decode(call: unknown[]) {
  const [payload, options] = call as [Uint8Array, { topic: string }];
  return { body: JSON.parse(new TextDecoder().decode(payload)), topic: options.topic };
}

beforeEach(() => {
  useCluster.setState({ activeContext: null });
});
afterEach(cleanup);

test("publishJson sends a reliable frame on the given topic", () => {
  const room = fakeRoom();
  publishJson(room, "rigel.context", { context: "deployment/web" });
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  expect(publishData).toHaveBeenCalledTimes(1);
  const { body, topic } = decode(publishData.mock.calls[0]!);
  expect(topic).toBe("rigel.context");
  expect(body).toEqual({ context: "deployment/web" });
  expect(publishData.mock.calls[0]![1]).toMatchObject({ reliable: true });
});

test("publishes the active context once on mount", () => {
  useCluster.setState({ activeContext: "prod" });
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  expect(publishData).toHaveBeenCalledTimes(1);
  const { body, topic } = decode(publishData.mock.calls[0]!);
  expect(topic).toBe("rigel.state");
  expect(body).toEqual({ activeContext: "prod" });
});

test("publishes again when the active context changes", () => {
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  expect(publishData).toHaveBeenCalledTimes(1);

  useCluster.getState().applySwitch("staging", null);
  expect(publishData).toHaveBeenCalledTimes(2);
  const { body } = decode(publishData.mock.calls[1]!);
  expect(body).toEqual({ activeContext: "staging" });
});

test("does not republish when an unrelated store field changes", () => {
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  expect(publishData).toHaveBeenCalledTimes(1);

  useCluster.getState().setNamespaceFilter("kube-system");
  expect(publishData).toHaveBeenCalledTimes(1);
});

test("stops publishing after unmount", () => {
  const room = fakeRoom();
  const { unmount } = render(<VoiceSessionEffects room={room} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  unmount();

  useCluster.getState().applySwitch("staging", null);
  expect(publishData).toHaveBeenCalledTimes(1);
});

test("renders nothing", () => {
  const room = fakeRoom();
  const { container } = render(<VoiceSessionEffects room={room} />);
  expect(container.innerHTML).toBe("");
});
