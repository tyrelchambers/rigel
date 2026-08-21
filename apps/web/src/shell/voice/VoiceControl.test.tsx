// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { Room } from "livekit-client";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => {
  const rooms: FakeRoom[] = [];
  const pendingDisconnects: (() => void)[] = [];
  const behavior = {
    failConnect: false,
    failMic: false,
    failMicDenied: false,
    failPublish: false,
    holdDisconnect: false,
  };
  class FakeRoom {
    handlers = new Map<string, () => void>();
    localParticipant = {
      setMicrophoneEnabled: vi.fn(async () => {
        // livekit-client rethrows getUserMedia's own DOMException here, so the
        // fake has to reject with the name and not a wrapper.
        if (behavior.failMicDenied) throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
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
      const fire = () => this.handlers.get("disconnected")?.();
      // holdDisconnect stretches that gap to whenever the test says, which is
      // the window a user reopening the popover in a hurry lands in.
      if (behavior.holdDisconnect) {
        pendingDisconnects.push(fire);
        return;
      }
      await Promise.resolve();
      fire();
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
    pendingDisconnects,
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
import { notReadyMessage, resultSummary, voiceButtonLabel, VoiceControl } from "./VoiceControl";
import { VoicePopoverBody } from "./VoicePopoverBody";
import { AGENT_REPORT_TIMEOUT_MS, isMicDenied, useAgentReport, useVoiceRoom } from "./useVoiceRoom";
import { AGENT_STATE_TOPIC } from "./VoiceSessionEffects";

beforeEach(() => {
  useCluster.setState({ activeContext: null, resources: {} });
  h.rooms.length = 0;
  h.fetchVoiceToken.mockClear();
  h.agent.state = "listening";
  h.transcriptions = [];
  h.behavior.failConnect = false;
  h.behavior.failMic = false;
  h.behavior.failMicDenied = false;
  h.behavior.failPublish = false;
  h.behavior.holdDisconnect = false;
  h.pendingDisconnects.length = 0;
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
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  expect(await screen.findByText(/Could not connect/)).toBeTruthy();
  await waitFor(() => expect(h.rooms).toHaveLength(1));
  expect(h.rooms[0]!.disconnect).toHaveBeenCalled();
  // The popover can only say "could not connect", so the real reason has to
  // reach the console or a media-path failure leaves no trace anywhere.
  expect(consoleError).toHaveBeenCalledWith("voice connect failed:", expect.anything());
  consoleError.mockRestore();

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
  // The user's bubble aligns itself to the right; the agent's is left by
  // structure, sharing a row with the mark that attributes it.
  expect((await screen.findByText("scale the api")).className).toContain("self-end");
  const agent = screen.getByText("scaled to three");
  expect(agent.className).not.toContain("self-end");
  expect(agent.className).toContain("rounded-tl-[4px]");
  expect(screen.getByText("Rigel")).toBeTruthy();
});

test("a resource the user named has its summary published to the worker", async () => {
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

  const published = () =>
    h.rooms[0]!.localParticipant.publishData.mock.calls.map(([payload]) =>
      JSON.parse(new TextDecoder().decode(payload as Uint8Array)),
    );
  await waitFor(() =>
    expect(published()).toContainEqual({ id: "dep-u-cm", context: "Deployment cert-manager in default: 2/2 ready, image —" }),
  );
});

test("the header mark ends the session instead of only hiding the popover", async () => {
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
  expect(await screen.findByText("End session")).toBeTruthy();
  expect(button.getAttribute("aria-label")).toBe("End voice session");
  expect(button.getAttribute("title")).toBe("End voice session");

  await userEvent.click(button);
  expect(h.rooms[0]!.disconnect).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText("End session")).toBeNull());
  expect(button.getAttribute("aria-label")).toBe("Voice assistant");

  h.transcriptions = [];
  await userEvent.click(button);
  await waitFor(() => expect(h.rooms).toHaveLength(2));
});

test("clicking again while connecting cancels instead of leaving an orphaned Room", async () => {
  h.status.data = { enabled: true, configured: true };
  let resolveToken: ((v: { url: string; token: string }) => void) | undefined;
  h.fetchVoiceToken.mockImplementationOnce(
    () => new Promise((resolve) => { resolveToken = resolve; }),
  );
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");

  await userEvent.click(button);
  expect(await screen.findByText("Connecting…")).toBeTruthy();
  expect(h.rooms).toHaveLength(0);

  await userEvent.click(button);
  expect(screen.queryByText("Connecting…")).toBeNull();

  await act(async () => {
    resolveToken?.({ url: "wss://example", token: "jwt" });
  });

  await waitFor(() => expect(h.rooms).toHaveLength(1));
  expect(h.rooms[0]!.connect).toHaveBeenCalled();
  await waitFor(() => expect(h.rooms[0]!.disconnect).toHaveBeenCalled());
  expect(screen.queryByLabelText("End voice session")).toBeNull();
  expect(screen.queryByText("End session")).toBeNull();
});

test("closing while connecting never leaves a Room reachable through a later reconnect", async () => {
  h.status.data = { enabled: true, configured: true };
  let resolveToken: ((v: { url: string; token: string }) => void) | undefined;
  h.fetchVoiceToken.mockImplementationOnce(
    () => new Promise((resolve) => { resolveToken = resolve; }),
  );
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");
  await userEvent.click(button);
  await userEvent.click(button);
  await act(async () => {
    resolveToken?.({ url: "wss://example", token: "jwt" });
  });
  await waitFor(() => expect(h.rooms).toHaveLength(1));
  await waitFor(() => expect(h.rooms[0]!.disconnect).toHaveBeenCalled());

  await userEvent.click(button);
  await waitFor(() => expect(h.rooms).toHaveLength(2));
  expect(await screen.findByText("End session")).toBeTruthy();
});

test("closing and reopening before Disconnected lands reconnects instead of dead-ending on Connecting", async () => {
  h.status.data = { enabled: true, configured: true };
  h.behavior.holdDisconnect = true;
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");
  await userEvent.click(button);
  await screen.findByText("End session");

  await userEvent.click(button);
  await userEvent.click(button);

  await waitFor(() => expect(h.rooms).toHaveLength(2));
  expect(await screen.findByText("End session")).toBeTruthy();

  // The hung-up room's Disconnected finally arrives. It belongs to a session
  // that has already been replaced and must not tear down the live one.
  act(() => h.pendingDisconnects.forEach((fire) => fire()));
  expect(screen.getByText("End session")).toBeTruthy();
  expect(screen.queryByText("Connecting…")).toBeNull();
});

test("cancelling a connect and reopening before it settles lands a session, not a dead Connecting", async () => {
  h.status.data = { enabled: true, configured: true };
  let resolveToken: ((v: { url: string; token: string }) => void) | undefined;
  h.fetchVoiceToken.mockImplementationOnce(
    () => new Promise((resolve) => { resolveToken = resolve; }),
  );
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");

  await userEvent.click(button);
  expect(await screen.findByText("Connecting…")).toBeTruthy();
  await userEvent.click(button);
  await userEvent.click(button);
  expect(screen.getByText("Connecting…")).toBeTruthy();

  await act(async () => {
    resolveToken?.({ url: "wss://example", token: "jwt" });
  });

  await waitFor(() => expect(h.rooms).toHaveLength(1));
  expect(await screen.findByText("End session")).toBeTruthy();
  expect(h.rooms[0]!.disconnect).not.toHaveBeenCalled();
});

test("a denied microphone reaches the popover as a permission problem, not a keys problem", async () => {
  h.status.data = { enabled: true, configured: true };
  h.behavior.failMicDenied = true;
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  expect(await screen.findByText(/microphone access/)).toBeTruthy();
  expect(screen.queryByText(/keys in Settings/)).toBeNull();
});

test("voiceButtonLabel only names the ending action while the popover is open on a live or in-flight session", () => {
  expect(voiceButtonLabel(false, "idle")).toBe("Voice assistant");
  expect(voiceButtonLabel(true, "idle")).toBe("Voice assistant");
  expect(voiceButtonLabel(true, "error")).toBe("Voice assistant");
  expect(voiceButtonLabel(false, "connected")).toBe("Voice assistant");
  expect(voiceButtonLabel(true, "connecting")).toBe("End voice session");
  expect(voiceButtonLabel(true, "connected")).toBe("End voice session");
});

test("a new session republishes a resource the last one had already pinned", async () => {
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
  const contextFrames = (i: number) =>
    h.rooms[i]!.localParticipant.publishData.mock.calls
      .map(([payload]) => JSON.parse(new TextDecoder().decode(payload as Uint8Array)) as { id?: string })
      .filter((f) => f.id === "node-u-node");
  await waitFor(() => expect(contextFrames(0)).toHaveLength(1));

  await userEvent.click(await screen.findByText("End session"));
  await userEvent.click(button);
  await waitFor(() => expect(h.rooms).toHaveLength(2));

  // The new session pins its own context rather than inheriting what the last
  // one had already told the worker.
  await waitFor(() => expect(contextFrames(1)).toHaveLength(1));
});

test("clicking again while connecting cancels instead of leaving an orphaned Room", async () => {
  h.status.data = { enabled: true, configured: true };
  let resolveToken: ((v: { url: string; token: string }) => void) | undefined;
  h.fetchVoiceToken.mockImplementationOnce(
    () => new Promise((resolve) => { resolveToken = resolve; }),
  );
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");

  await userEvent.click(button);
  expect(await screen.findByText("Connecting…")).toBeTruthy();
  expect(h.rooms).toHaveLength(0);

  await userEvent.click(button);
  expect(screen.queryByText("Connecting…")).toBeNull();

  await act(async () => {
    resolveToken?.({ url: "wss://example", token: "jwt" });
  });

  await waitFor(() => expect(h.rooms).toHaveLength(1));
  expect(h.rooms[0]!.connect).toHaveBeenCalled();
  await waitFor(() => expect(h.rooms[0]!.disconnect).toHaveBeenCalled());
  expect(screen.queryByLabelText("End voice session")).toBeNull();
  expect(screen.queryByText("End session")).toBeNull();
});

test("closing while connecting never leaves a Room reachable through a later reconnect", async () => {
  h.status.data = { enabled: true, configured: true };
  let resolveToken: ((v: { url: string; token: string }) => void) | undefined;
  h.fetchVoiceToken.mockImplementationOnce(
    () => new Promise((resolve) => { resolveToken = resolve; }),
  );
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");
  await userEvent.click(button);
  await userEvent.click(button);
  await act(async () => {
    resolveToken?.({ url: "wss://example", token: "jwt" });
  });
  await waitFor(() => expect(h.rooms).toHaveLength(1));
  await waitFor(() => expect(h.rooms[0]!.disconnect).toHaveBeenCalled());

  await userEvent.click(button);
  await waitFor(() => expect(h.rooms).toHaveLength(2));
  expect(await screen.findByText("End session")).toBeTruthy();
});

test("closing and reopening before Disconnected lands reconnects instead of dead-ending on Connecting", async () => {
  h.status.data = { enabled: true, configured: true };
  h.behavior.holdDisconnect = true;
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");
  await userEvent.click(button);
  await screen.findByText("End session");

  await userEvent.click(button);
  await userEvent.click(button);

  await waitFor(() => expect(h.rooms).toHaveLength(2));
  expect(await screen.findByText("End session")).toBeTruthy();

  // The hung-up room's Disconnected finally arrives. It belongs to a session
  // that has already been replaced and must not tear down the live one.
  act(() => h.pendingDisconnects.forEach((fire) => fire()));
  expect(screen.getByText("End session")).toBeTruthy();
  expect(screen.queryByText("Connecting…")).toBeNull();
});

test("cancelling a connect and reopening before it settles lands a session, not a dead Connecting", async () => {
  h.status.data = { enabled: true, configured: true };
  let resolveToken: ((v: { url: string; token: string }) => void) | undefined;
  h.fetchVoiceToken.mockImplementationOnce(
    () => new Promise((resolve) => { resolveToken = resolve; }),
  );
  render(<VoiceControl />);
  const button = screen.getByLabelText("Voice assistant");

  await userEvent.click(button);
  expect(await screen.findByText("Connecting…")).toBeTruthy();
  await userEvent.click(button);
  await userEvent.click(button);
  expect(screen.getByText("Connecting…")).toBeTruthy();

  await act(async () => {
    resolveToken?.({ url: "wss://example", token: "jwt" });
  });

  await waitFor(() => expect(h.rooms).toHaveLength(1));
  expect(await screen.findByText("End session")).toBeTruthy();
  expect(h.rooms[0]!.disconnect).not.toHaveBeenCalled();
});

test("a denied microphone reaches the popover as a permission problem, not a keys problem", async () => {
  h.status.data = { enabled: true, configured: true };
  h.behavior.failMicDenied = true;
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  expect(await screen.findByText(/microphone access/)).toBeTruthy();
  expect(screen.queryByText(/keys in Settings/)).toBeNull();
});

test("voiceButtonLabel only names the ending action while the popover is open on a live or in-flight session", () => {
  expect(voiceButtonLabel(false, "idle")).toBe("Voice assistant");
  expect(voiceButtonLabel(true, "idle")).toBe("Voice assistant");
  expect(voiceButtonLabel(true, "error")).toBe("Voice assistant");
  expect(voiceButtonLabel(false, "connected")).toBe("Voice assistant");
  expect(voiceButtonLabel(true, "connecting")).toBe("End voice session");
  expect(voiceButtonLabel(true, "connected")).toBe("End voice session");
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
  expect(notReadyMessage(false, "error", null)).toMatch(/Settings/);
  expect(notReadyMessage(true, "error", "connect")).toMatch(/Could not connect/);
  expect(notReadyMessage(true, "connecting", null)).toBe("Connecting…");
  expect(notReadyMessage(true, "idle", null)).toBe("Connecting…");
});

test("a denied microphone points at the system settings, not the voice keys", () => {
  expect(notReadyMessage(true, "error", "mic-denied")).toMatch(/microphone access/);
  expect(notReadyMessage(true, "error", "mic-denied")).not.toMatch(/keys/);
});

test("isMicDenied reads the DOMException name getUserMedia actually rejects with", () => {
  expect(isMicDenied(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }))).toBe(true);
  expect(isMicDenied(Object.assign(new Error("denied"), { name: "PermissionDeniedError" }))).toBe(true);
  expect(isMicDenied(new Error("voice token failed: 409"))).toBe(false);
  expect(isMicDenied(undefined)).toBe(false);
});

const AGENT = "rigel-agent";

/** A proposal shaped exactly the way apps/voice/src/agent.ts sends it. */
const CLICK_FRAME = {
  id: "call-1",
  action: { kind: "deleteResource", label: "Delete pod web-1", name: "web-1", namespace: "default" },
  command: "kubectl delete pod web-1 -n default",
};

/** The command block splits the command across spans for syntax emphasis, so
 *  it is matched on the block's text rather than a single text node. */
function commandBlock(command: string) {
  return screen.findByText(
    (_content, el) => el?.tagName === "PRE" && (el.textContent ?? "").includes(command),
  );
}

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

test("a proposal renders its command and a button labelled by the action", async () => {
  await openWithClickProposal();

  expect(await commandBlock("kubectl delete pod web-1 -n default")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete pod web-1" })).toBeTruthy();
});

test("no proposal can be run by speaking: every one carries a button and no spoken prompt", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("End session");
  deliver("rigel.action", { ...CLICK_FRAME, action: { kind: "restart", label: "Restart web" } }, AGENT);

  expect(await screen.findByRole("button", { name: "Restart web" })).toBeTruthy();
  expect(screen.queryByText(/confirm/i)).toBeNull();
});

test("a proposal carrying no command renders its target rather than an empty command", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("End session");
  deliver(
    "rigel.action",
    { id: "call-2", action: { kind: "purge", label: "Remove memos", name: "memos", namespace: "default" }, command: null },
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

  expect(document.querySelector("pre")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete pod web-1" })).toBeNull();
});

test("clicking the button opens the ConfirmSheet on the exact action block", async () => {
  await openWithClickProposal();
  await userEvent.click(await screen.findByRole("button", { name: "Delete pod web-1" }));

  expect(JSON.parse(screen.getByTestId("confirm-action").textContent!)).toEqual(CLICK_FRAME.action);
});

test("pressing Escape ends the session, because closing the window means leaving", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await waitFor(() => expect(h.rooms).toHaveLength(1));

  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(h.rooms[0]!.disconnect).toHaveBeenCalled());
});

test("clicking away ends the session too", async () => {
  h.status.data = { enabled: true, configured: true };
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await waitFor(() => expect(h.rooms).toHaveLength(1));

  await userEvent.click(document.body);

  await waitFor(() => expect(h.rooms[0]!.disconnect).toHaveBeenCalled());
});

test("a proposal's confirm sheet closes the popover without hanging up on the session", async () => {
  await openWithClickProposal();
  await userEvent.click(await screen.findByRole("button", { name: "Delete pod web-1" }));

  // The sheet steals focus, which closes the popover. Ending the session here
  // would drop the room before the result could be reported back to the worker.
  expect(h.rooms[0]!.disconnect).not.toHaveBeenCalled();
});

test("a successful run is published back to the worker and marked on the row", async () => {
  await openWithClickProposal();
  await userEvent.click(await screen.findByRole("button", { name: "Delete pod web-1" }));
  await userEvent.click(screen.getByRole("button", { name: "fake-run" }));

  await waitFor(() => expect(publishedOn("rigel.action.result")).toEqual([{ id: "call-1", ok: true, summary: "ran" }]));
  // Opening the confirm dialog dismisses the popover, which is why the sheet is
  // mounted outside it; the row is still there when the popover comes back.
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText("ran")).toBeTruthy();
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

test("a rigel.action.result marks the proposal done and retires its button", async () => {
  await openWithClickProposal();
  expect(await screen.findByRole("button", { name: "Delete pod web-1" })).toBeTruthy();
  expect(await commandBlock("kubectl delete pod web-1 -n default")).toBeTruthy();

  deliver("rigel.action.result", { id: "call-1", ok: true, summary: "ran" }, AGENT);

  expect(await screen.findByText("ran")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete pod web-1" })).toBeNull();
});

test("a new session starts with no proposals from the last one", async () => {
  await openWithClickProposal();
  expect(await commandBlock("kubectl delete pod web-1 -n default")).toBeTruthy();

  await userEvent.click(screen.getByText("End session"));
  await userEvent.click(screen.getByLabelText("Voice assistant"));

  await waitFor(() => expect(h.rooms).toHaveLength(2));
  expect(await screen.findByText("End session")).toBeTruthy();
  expect(document.querySelector("pre")).toBeNull();
});

test("resultSummary caps a runaway stderr line so the packet cannot blow the 64KB ceiling", () => {
  const { ok, summary } = resultSummary({ code: 1, stdout: "", stderr: "x".repeat(5000) });
  expect(ok).toBe(false);
  expect(summary).toHaveLength(400);
});

test("the waveform rests at a baseline instead of vanishing when no track is published", async () => {
  h.status.data = { enabled: true, configured: true };
  const { baseElement } = render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("End session");

  // useMultibandTrackVolume hands back [] with no track, which used to render
  // an empty band.
  const bars = baseElement.querySelectorAll("[data-voice-waveform] > div");
  expect(bars).toHaveLength(28);
  expect((bars[0] as HTMLElement).style.height).toBe("6px");
});

test("the worker's own state report drives the popover, not the hook", async () => {
  h.status.data = { enabled: true, configured: true };
  // What the live session actually produced: the pipeline was hearing and
  // answering while useVoiceAssistant sat on "connecting" forever.
  h.agent.state = "connecting";
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  expect(await screen.findByText("Connecting…")).toBeTruthy();

  deliver(AGENT_STATE_TOPIC, { state: "thinking" }, AGENT);

  expect(await screen.findByText("Thinking")).toBeTruthy();
});

test("a state report from a phone cannot move the popover", async () => {
  h.status.data = { enabled: true, configured: true };
  h.agent.state = "connecting";
  render(<VoiceControl />);
  await userEvent.click(screen.getByLabelText("Voice assistant"));
  await screen.findByText("Connecting…");

  deliver(AGENT_STATE_TOPIC, { state: "speaking" }, "rigel-phone-abc");

  expect(screen.getByText("Connecting…")).toBeTruthy();
});

test("useAgentReport starts silent and gives up after the timeout", () => {
  vi.useFakeTimers();
  try {
    const room = new h.FakeRoom() as unknown as Room;
    const { result } = renderHook(() => useAgentReport(room));
    expect(result.current.report).toEqual({ state: null, timedOut: false });
    act(() => vi.advanceTimersByTime(AGENT_REPORT_TIMEOUT_MS));
    expect(result.current.report).toEqual({ state: null, timedOut: true });
  } finally {
    vi.useRealTimers();
  }
});

test("useAgentReport drops the last report when the room changes, since a report is per session", () => {
  const { result, rerender } = renderHook(({ room }) => useAgentReport(room), {
    initialProps: { room: new h.FakeRoom() as unknown as Room },
  });
  act(() => result.current.onAgentState("speaking"));
  expect(result.current.report.state).toBe("speaking");

  rerender({ room: new h.FakeRoom() as unknown as Room });

  expect(result.current.report.state).toBeNull();
});

test("a timed-out report reaches the popover's failure label, which the hook could never produce", () => {
  h.agent.state = "connecting";
  render(
    <VoicePopoverBody
      report={{ state: null, timedOut: true }}
      onEnd={() => {}}
      actions={[]}
      onRunClick={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByText("Agent unavailable")).toBeTruthy();
});
