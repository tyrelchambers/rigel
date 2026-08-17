// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => {
  const rooms: FakeRoom[] = [];
  const behavior = { failConnect: false, failMic: false };
  class FakeRoom {
    handlers = new Map<string, () => void>();
    localParticipant = {
      setMicrophoneEnabled: vi.fn(async () => {
        if (behavior.failMic) throw new Error("mic failed");
      }),
      publishData: vi.fn(),
    };
    connect = vi.fn(async () => {
      if (behavior.failConnect) throw new Error("connect failed");
    });
    disconnect = vi.fn(async () => {
      // Deferred like the real SDK: Disconnected fires after teardown, not
      // synchronously inside the disconnect() call, so a bug that leaves the
      // listener attached only shows up once the surrounding catch block has
      // already finished and set its own status.
      await Promise.resolve();
      this.handlers.get("disconnected")?.();
    });
    constructor() {
      rooms.push(this);
    }
    on(event: string, fn: () => void) {
      this.handlers.set(event, fn);
      return this;
    }
    off(event: string) {
      this.handlers.delete(event);
      return this;
    }
  }
  return {
    rooms,
    FakeRoom,
    behavior,
    status: { data: undefined as { enabled: boolean; configured: boolean } | undefined },
    fetchVoiceToken: vi.fn(async () => ({ url: "wss://example", token: "jwt" })),
    agent: { state: "listening" },
    transcriptions: [] as { text: string; participantInfo: { identity: string } }[],
  };
});

vi.mock("@/lib/api", () => ({
  useVoiceStatus: () => ({ data: h.status.data }),
  fetchVoiceToken: h.fetchVoiceToken,
}));
vi.mock("livekit-client", () => ({
  Room: h.FakeRoom,
  RoomEvent: { Disconnected: "disconnected" },
  Track: { Source: { Microphone: "microphone" } },
}));
vi.mock("@livekit/components-react", () => ({
  RoomContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
  RoomAudioRenderer: () => null,
  useVoiceAssistant: () => ({ state: h.agent.state, audioTrack: undefined }),
  useTranscriptions: () => h.transcriptions,
  useTrackVolume: () => 0,
  useMultibandTrackVolume: () => [],
  useLocalParticipant: () => ({ microphoneTrack: undefined, localParticipant: undefined }),
}));

import { notReadyMessage, VoiceControl } from "./VoiceControl";
import { useVoiceRoom } from "./useVoiceRoom";

beforeEach(() => {
  h.rooms.length = 0;
  h.fetchVoiceToken.mockClear();
  h.agent.state = "listening";
  h.transcriptions = [];
  h.behavior.failConnect = false;
  h.behavior.failMic = false;
});
afterEach(cleanup);

test("renders nothing when the voice flag is off", () => {
  h.status.data = { enabled: false, configured: false };
  render(<VoiceControl />);
  expect(screen.queryByLabelText("Voice assistant")).toBeNull();
});

test("renders nothing before the status query answers", () => {
  h.status.data = undefined;
  render(<VoiceControl />);
  expect(screen.queryByLabelText("Voice assistant")).toBeNull();
});

test("renders the header button when enabled", () => {
  h.status.data = { enabled: true, configured: false };
  render(<VoiceControl />);
  expect(screen.getByLabelText("Voice assistant")).toBeTruthy();
});

test("enabled but unconfigured points at Settings and never asks for a token", async () => {
  h.status.data = { enabled: true, configured: false };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText(/keys in Settings to use voice/)).toBeTruthy();
  expect(h.fetchVoiceToken).not.toHaveBeenCalled();
  expect(h.rooms).toHaveLength(0);
});

test("opening while configured connects a room and publishes the mic", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  await waitFor(() => expect(h.rooms).toHaveLength(1));
  const room = h.rooms[0]!;
  expect(room.connect).toHaveBeenCalledWith("wss://example", "jwt");
  await waitFor(() => expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true));
  expect(await screen.findByText("Listening")).toBeTruthy();
});

test("End session disconnects the room and closes the popover", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  const end = await screen.findByText("End session");
  await userEvent.click(end);
  expect(h.rooms[0]!.disconnect).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText("End session")).toBeNull());
});

test("a failed token request surfaces the retry copy instead of hanging on Connecting", async () => {
  h.status.data = { enabled: true, configured: true };
  h.fetchVoiceToken.mockRejectedValueOnce(new Error("voice token failed: 409"));
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText(/Could not connect/)).toBeTruthy();
});

test("Room.connect rejecting lands on error and stays there once the deferred Disconnected fires", async () => {
  h.status.data = { enabled: true, configured: true };
  h.behavior.failConnect = true;
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  expect(await screen.findByText(/Could not connect/)).toBeTruthy();
  await waitFor(() => expect(h.rooms).toHaveLength(1));
  expect(h.rooms[0]!.disconnect).toHaveBeenCalled();

  await waitFor(() => expect(h.rooms[0]!.handlers.has("disconnected")).toBe(false));
  expect(screen.getByText(/Could not connect/)).toBeTruthy();
  expect(screen.queryByText("Connecting…")).toBeNull();
});

test("setMicrophoneEnabled rejecting lands on error and stays there once the deferred Disconnected fires", async () => {
  h.status.data = { enabled: true, configured: true };
  h.behavior.failMic = true;
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  expect(await screen.findByText(/Could not connect/)).toBeTruthy();
  await waitFor(() => expect(h.rooms).toHaveLength(1));
  expect(h.rooms[0]!.connect).toHaveBeenCalled();
  expect(h.rooms[0]!.disconnect).toHaveBeenCalled();

  await waitFor(() => expect(h.rooms[0]!.handlers.has("disconnected")).toBe(false));
  expect(screen.getByText(/Could not connect/)).toBeTruthy();
  expect(screen.queryByText("Connecting…")).toBeNull();
});

test("reopening after a failure retries, which is what the failure copy promises", async () => {
  h.status.data = { enabled: true, configured: true };
  h.fetchVoiceToken.mockRejectedValueOnce(new Error("voice token failed: 409"));
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");
  await userEvent.click(button);
  await screen.findByText(/Could not connect/);

  await userEvent.click(button);
  await userEvent.click(button);
  await waitFor(() => expect(h.rooms).toHaveLength(1));
  expect(await screen.findByText("End session")).toBeTruthy();
});

test("the agent state names itself in the popover header", async () => {
  h.status.data = { enabled: true, configured: true };
  h.agent.state = "thinking";
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText("Thinking")).toBeTruthy();
});

test("an empty transcript prompts the user to speak", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText(/Your words appear here as you speak/)).toBeTruthy();
});

test("agent lines and user lines land on opposite sides of the transcript", async () => {
  h.status.data = { enabled: true, configured: true };
  h.transcriptions = [
    { text: "scale the api", participantInfo: { identity: "rigel-desktop" } },
    { text: "scaled to three", participantInfo: { identity: "rigel-agent" } },
  ];
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect((await screen.findByText("scale the api")).className).toContain("self-end");
  expect(screen.getByText("scaled to three").className).toContain("self-start");
});

test("two connect() calls fired before the token resolves only produce one Room", async () => {
  const { result } = renderHook(() => useVoiceRoom());

  await act(async () => {
    await Promise.all([result.current.connect(), result.current.connect()]);
  });

  expect(h.fetchVoiceToken).toHaveBeenCalledTimes(1);
  expect(h.rooms).toHaveLength(1);
});

test("notReadyMessage distinguishes unconfigured, failed and in-flight", () => {
  expect(notReadyMessage(false, "error")).toMatch(/Settings/);
  expect(notReadyMessage(true, "error")).toMatch(/Could not connect/);
  expect(notReadyMessage(true, "connecting")).toBe("Connecting…");
  expect(notReadyMessage(true, "idle")).toBe("Connecting…");
});
