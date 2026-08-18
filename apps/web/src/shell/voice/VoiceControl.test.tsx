// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => {
  const rooms: FakeRoom[] = [];
  const behavior = { failConnect: false, failMic: false, failPublish: false };
  class FakeRoom {
    handlers = new Map<string, () => void>();
    localParticipant = {
      setMicrophoneEnabled: vi.fn(async () => {
        if (behavior.failMic) throw new Error("mic failed");
      }),
      publishData: vi.fn(async (_payload: Uint8Array, options: { topic: string }) => {
        if (behavior.failPublish && options.topic === "rigel.action.result") {
          throw new Error("data packet is too big");
        }
      }),
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
    channels: [] as { topic: string; cb?: (msg: unknown) => void }[],
    actionResult: { code: 0, stdout: "", stderr: "" },
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
  useDataChannel: (topic: string, cb?: (msg: unknown) => void) => {
    h.channels.push({ topic, cb });
    return { isSending: false, send: async () => {}, message: undefined };
  },
}));
vi.mock("@/components/ConfirmSheet", () => ({
  ConfirmSheet: ({
    action,
    open,
    onResult,
  }: {
    action: unknown;
    open: boolean;
    onResult?: (info: { action: unknown; result: typeof h.actionResult; commandString: string }) => void;
  }) =>
    open ? (
      <div>
        <span data-testid="confirm-action">{JSON.stringify(action)}</span>
        <button onClick={() => onResult?.({ action, result: h.actionResult, commandString: "cmd" })}>fake-run</button>
      </div>
    ) : null,
}));

import { useCluster } from "@/store/cluster";
import { notReadyMessage, resultSummary, VoiceControl } from "./VoiceControl";
import { useVoiceRoom } from "./useVoiceRoom";

beforeEach(() => {
  useCluster.setState({ activeContext: null, resources: {} });
  h.rooms.length = 0;
  h.fetchVoiceToken.mockClear();
  h.agent.state = "listening";
  h.transcriptions = [];
  h.behavior.failConnect = false;
  h.behavior.failMic = false;
  h.behavior.failPublish = false;
  h.channels.length = 0;
  h.actionResult = { code: 0, stdout: "", stderr: "" };
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

test("a resource the user named shows up as a pill and its summary reaches the worker", async () => {
  h.status.data = { enabled: true, configured: true };
  useCluster.setState({
    resources: {
      deployments: {
        "default/cert-manager": {
          metadata: { uid: "u-cm", name: "cert-manager", namespace: "default" },
          spec: { replicas: 2 },
          status: { readyReplicas: 2 },
        },
      },
    },
  });
  h.transcriptions = [{ text: "restart cert manager", participantInfo: { identity: "rigel-desktop" } }];
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  expect(await screen.findByText("DEPLOY")).toBeTruthy();
  expect(screen.getByText("cert-manager")).toBeTruthy();
  const published = h.rooms[0]!.localParticipant.publishData.mock.calls.map(
    ([payload]) => JSON.parse(new TextDecoder().decode(payload as Uint8Array)),
  );
  expect(published).toContainEqual({ id: "dep-u-cm", context: "Deployment cert-manager in default: 2/2 ready, image —" });
});

test("pills outlive the popover closing", async () => {
  h.status.data = { enabled: true, configured: true };
  useCluster.setState({
    resources: {
      nodes: { "k3s-slave": { metadata: { uid: "u-node", name: "k3s-slave" }, status: { conditions: [] } } },
    },
  });
  h.transcriptions = [{ text: "cordon k3s slave", participantInfo: { identity: "rigel-desktop" } }];
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");
  await userEvent.click(button);
  expect(await screen.findByText("NODE")).toBeTruthy();

  await userEvent.click(button);
  await waitFor(() => expect(screen.queryByText("NODE")).toBeNull());
  await userEvent.click(button);
  expect(await screen.findByText("NODE")).toBeTruthy();
});

test("a new session starts with no pills from the last one", async () => {
  h.status.data = { enabled: true, configured: true };
  useCluster.setState({
    resources: {
      nodes: { "k3s-slave": { metadata: { uid: "u-node", name: "k3s-slave" }, status: { conditions: [] } } },
    },
  });
  h.transcriptions = [{ text: "cordon k3s slave", participantInfo: { identity: "rigel-desktop" } }];
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");
  await userEvent.click(button);
  expect(await screen.findByText("NODE")).toBeTruthy();

  await userEvent.click(await screen.findByText("End session"));
  h.transcriptions = [];
  await userEvent.click(button);

  await waitFor(() => expect(h.rooms).toHaveLength(2));
  expect(await screen.findByText("End session")).toBeTruthy();
  expect(screen.queryByText("NODE")).toBeNull();
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

const AGENT = "rigel-agent";

/** A click-tier proposal shaped exactly the way apps/voice/src/agent.ts sends it. */
const CLICK_FRAME = {
  id: "call-1",
  tier: "click",
  action: { kind: "deleteResource", label: "Delete pod web-1", name: "web-1", namespace: "default" },
  command: "kubectl delete pod web-1 -n default",
};

/** Hands one frame to the live handler for that topic, as the room would. */
function deliver(topic: string, body: unknown, identity: string) {
  const msg = {
    payload: new TextEncoder().encode(JSON.stringify(body)),
    topic,
    from: { identity },
  };
  const forTopic = h.channels.filter((c) => c.topic === topic);
  const live = forTopic[forTopic.length - 1];
  act(() => live?.cb?.(msg));
}

function publishedOn(topic: string) {
  return h.rooms[0]!.localParticipant.publishData.mock.calls
    .filter(([, options]) => (options as { topic: string }).topic === topic)
    .map(([payload]) => JSON.parse(new TextDecoder().decode(payload as Uint8Array)));
}

/** Opens the popover on a live session with one click-tier proposal pending. */
async function openWithClickProposal() {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("End session");
  deliver("rigel.action", CLICK_FRAME, AGENT);
}

test("a click-tier proposal renders its command and a button labelled by the action", async () => {
  await openWithClickProposal();

  expect(await screen.findByText("kubectl delete pod web-1 -n default")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete pod web-1" })).toBeTruthy();
});

test("a voice-tier proposal renders the spoken-confirm hint instead of a button", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("End session");
  deliver("rigel.action", { ...CLICK_FRAME, tier: "voice", action: { kind: "restart", label: "Restart web" } }, AGENT);

  expect(await screen.findByText(/Say "confirm" to run/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Restart web" })).toBeNull();
});

test("a proposal carrying no command renders its target rather than an empty command", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("End session");
  deliver(
    "rigel.action",
    { id: "call-2", tier: "click", action: { kind: "purge", label: "Remove memos", name: "memos", namespace: "default" }, command: null },
    AGENT,
  );

  expect(await screen.findByText("purge memos in default")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove memos" })).toBeTruthy();
});

test("a rigel.action frame from a non-agent identity never reaches the popover", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("End session");

  deliver("rigel.action", CLICK_FRAME, "rigel-phone-abc");

  expect(screen.queryByText("kubectl delete pod web-1 -n default")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete pod web-1" })).toBeNull();
});

test("clicking the button opens the ConfirmSheet on the exact action block", async () => {
  await openWithClickProposal();
  await userEvent.click(await screen.findByRole("button", { name: "Delete pod web-1" }));

  expect(JSON.parse(screen.getByTestId("confirm-action").textContent!)).toEqual(CLICK_FRAME.action);
});

test("a successful run is published back to the worker and marked on the row", async () => {
  await openWithClickProposal();
  await userEvent.click(await screen.findByRole("button", { name: "Delete pod web-1" }));
  await userEvent.click(screen.getByRole("button", { name: "fake-run" }));

  await waitFor(() => expect(publishedOn("rigel.action.result")).toEqual([{ id: "call-1", ok: true, summary: "ran" }]));
  // Opening the confirm dialog dismisses the popover, which is why the sheet is
  // mounted outside it; the row is still there when the popover comes back.
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText("Ran")).toBeTruthy();
});

test("a failed run reports the first stderr line rather than a generic failure", async () => {
  h.actionResult = { code: 1, stdout: "", stderr: "\nError from server (NotFound): pods \"web-1\" not found\nmore" };
  await openWithClickProposal();
  await userEvent.click(await screen.findByRole("button", { name: "Delete pod web-1" }));
  await userEvent.click(screen.getByRole("button", { name: "fake-run" }));

  await waitFor(() =>
    expect(publishedOn("rigel.action.result")).toEqual([
      { id: "call-1", ok: false, summary: 'Error from server (NotFound): pods "web-1" not found' },
    ]),
  );
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText('Error from server (NotFound): pods "web-1" not found')).toBeTruthy();
});

test("a result publish that fails surfaces on the row instead of being swallowed", async () => {
  h.behavior.failPublish = true;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  await openWithClickProposal();
  await userEvent.click(await screen.findByRole("button", { name: "Delete pod web-1" }));
  await userEvent.click(screen.getByRole("button", { name: "fake-run" }));

  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText("Ran, but the assistant was not told.")).toBeTruthy();
  expect(consoleError).toHaveBeenCalled();
  consoleError.mockRestore();
});

test("a rigel.action.result from the worker marks a voice-tier proposal done", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("End session");
  deliver("rigel.action", { ...CLICK_FRAME, tier: "voice" }, AGENT);
  expect(await screen.findByText(/Say "confirm" to run/)).toBeTruthy();

  deliver("rigel.action.result", { id: "call-1", ok: true, summary: "ran" }, AGENT);

  expect(await screen.findByText("Ran")).toBeTruthy();
  expect(screen.queryByText(/Say "confirm" to run/)).toBeNull();
});

test("a new session starts with no proposals from the last one", async () => {
  await openWithClickProposal();
  expect(await screen.findByText("kubectl delete pod web-1 -n default")).toBeTruthy();

  await userEvent.click(screen.getByText("End session"));
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  await waitFor(() => expect(h.rooms).toHaveLength(2));
  expect(await screen.findByText("End session")).toBeTruthy();
  expect(screen.queryByText("kubectl delete pod web-1 -n default")).toBeNull();
});

test("resultSummary caps a runaway stderr line so the packet cannot blow the 64KB ceiling", () => {
  const { ok, summary } = resultSummary({ code: 1, stdout: "", stderr: "x".repeat(5000) });
  expect(ok).toBe(false);
  expect(summary).toHaveLength(400);
});
