// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Room } from "livekit-client";
import { useCluster } from "@/store/cluster";
import { loadSessions } from "@/panels/chat/chatHistory";

interface FakeTranscript {
  text: string;
  participantInfo?: { identity: string };
  streamInfo?: { id: string; attributes?: Record<string, string> };
}

const h = vi.hoisted(() => ({ transcriptions: [] as FakeTranscript[] }));
vi.mock("@livekit/components-react", () => ({ useTranscriptions: () => h.transcriptions }));

import { publishJson, VoiceSessionEffects } from "./VoiceSessionEffects";

function finalSegment(id: string, text: string, identity: string): FakeTranscript {
  return {
    text,
    participantInfo: { identity },
    streamInfo: { id, attributes: { "lk.transcription_final": "true" } },
  };
}

function interimSegment(id: string, text: string, identity: string): FakeTranscript {
  return {
    text,
    participantInfo: { identity },
    streamInfo: { id, attributes: { "lk.transcription_final": "false" } },
  };
}

function fakeRoom() {
  return { localParticipant: { publishData: vi.fn() } } as unknown as Room;
}

function decode(call: unknown[]) {
  const [payload, options] = call as [Uint8Array, { topic: string }];
  return { body: JSON.parse(new TextDecoder().decode(payload)), topic: options.topic };
}

/** The pills the component last handed up, which is what the popover renders. */
function pillCollector() {
  const onPills = vi.fn();
  return {
    onPills,
    names: () => ((onPills.mock.calls[onPills.mock.calls.length - 1]?.[0] ?? []) as { name: string }[]).map((p) => p.name),
  };
}

function frames(room: Room, topic: string) {
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  return publishData.mock.calls.map(decode).filter((f) => f.topic === topic).map((f) => f.body);
}

/** Two deployments and one of web's pods, shaped the way the watch store holds them. */
const RESOURCES = {
  deployments: {
    "default/web": { metadata: { uid: "u-web", name: "web", namespace: "default" }, spec: { replicas: 3 }, status: { readyReplicas: 1 } },
    "default/cert-manager": { metadata: { uid: "u-cm", name: "cert-manager", namespace: "default" }, spec: { replicas: 1 }, status: { readyReplicas: 1 } },
  },
  pods: {
    "default/web-7f9b64c8d-x2x4p": { metadata: { uid: "u-pod", name: "web-7f9b64c8d-x2x4p", namespace: "default" }, status: { phase: "Running" } },
  },
};

beforeEach(() => {
  useCluster.setState({ activeContext: null, resources: {} });
  h.transcriptions = [];
  localStorage.clear();
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
  render(<VoiceSessionEffects room={room} onPills={() => {}} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  expect(publishData).toHaveBeenCalledTimes(1);
  const { body, topic } = decode(publishData.mock.calls[0]!);
  expect(topic).toBe("rigel.state");
  expect(body).toEqual({ activeContext: "prod" });
});

test("publishes again when the active context changes", () => {
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} onPills={() => {}} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  expect(publishData).toHaveBeenCalledTimes(1);

  useCluster.getState().applySwitch("staging", null);
  expect(publishData).toHaveBeenCalledTimes(2);
  const { body } = decode(publishData.mock.calls[1]!);
  expect(body).toEqual({ activeContext: "staging" });
});

test("does not republish when an unrelated store field changes", () => {
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} onPills={() => {}} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  expect(publishData).toHaveBeenCalledTimes(1);

  useCluster.getState().setNamespaceFilter("kube-system");
  expect(publishData).toHaveBeenCalledTimes(1);
});

test("stops publishing after unmount", () => {
  const room = fakeRoom();
  const { unmount } = render(<VoiceSessionEffects room={room} onPills={() => {}} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  unmount();

  useCluster.getState().applySwitch("staging", null);
  expect(publishData).toHaveBeenCalledTimes(1);
});

test("renders nothing", () => {
  const room = fakeRoom();
  const { container } = render(<VoiceSessionEffects room={room} onPills={() => {}} />);
  expect(container.innerHTML).toBe("");
});

test("a spoken resource name publishes its summary and becomes a pill", () => {
  useCluster.setState({ resources: RESOURCES });
  h.transcriptions = [{ text: "what's up with cert manager", participantInfo: { identity: "rigel-desktop" } }];
  const room = fakeRoom();
  const pills = pillCollector();

  render(<VoiceSessionEffects room={room} onPills={pills.onPills} />);

  expect(frames(room, "rigel.context")).toEqual([
    { id: "dep-u-cm", context: "Deployment cert-manager in default: 1/1 ready, image \u2014" },
  ]);
  expect(pills.names()).toEqual(["cert-manager"]);
});

test("the same resource named again in a later turn is not republished", () => {
  useCluster.setState({ resources: RESOURCES });
  h.transcriptions = [{ text: "check certmanager", participantInfo: { identity: "rigel-desktop" } }];
  const room = fakeRoom();
  const pills = pillCollector();
  const { rerender } = render(<VoiceSessionEffects room={room} onPills={pills.onPills} />);
  expect(frames(room, "rigel.context")).toHaveLength(1);

  h.transcriptions = [...h.transcriptions, { text: "and cert manager again", participantInfo: { identity: "rigel-desktop" } }];
  rerender(<VoiceSessionEffects room={room} onPills={pills.onPills} />);

  expect(frames(room, "rigel.context")).toHaveLength(1);
  expect(pills.names()).toEqual(["cert-manager"]);
});

test("what the agent says back never pins a resource", () => {
  useCluster.setState({ resources: RESOURCES });
  h.transcriptions = [{ text: "cert manager is healthy", participantInfo: { identity: "rigel-agent-1" } }];
  const room = fakeRoom();
  const pills = pillCollector();

  render(<VoiceSessionEffects room={room} onPills={pills.onPills} />);

  expect(frames(room, "rigel.context")).toEqual([]);
  expect(pills.names()).toEqual([]);
});

test("pills are capped at six, keeping the most recent", () => {
  const deployments: Record<string, unknown> = {};
  for (let i = 0; i < 8; i++) {
    deployments[`default/svc-${i}`] = { metadata: { uid: `u-${i}`, name: `svc-${i}`, namespace: "default" } };
  }
  useCluster.setState({ resources: { deployments } });
  h.transcriptions = [
    { text: "svc-0 svc-1 svc-2 svc-3 svc-4 svc-5 svc-6 svc-7", participantInfo: { identity: "rigel-desktop" } },
  ];
  const room = fakeRoom();
  const pills = pillCollector();

  render(<VoiceSessionEffects room={room} onPills={pills.onPills} />);

  expect(frames(room, "rigel.context")).toHaveLength(8);
  expect(pills.names()).toEqual(["svc-2", "svc-3", "svc-4", "svc-5", "svc-6", "svc-7"]);
});

test("a final user segment is recorded into chat history", () => {
  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  const room = fakeRoom();

  render(<VoiceSessionEffects room={room} onPills={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.title).toBe("Voice session");
  expect(sessions[0]!.messages.map((m) => [m.role, m.text])).toEqual([["user", "restart web"]]);
});

test("a final agent segment is recorded as an assistant message", () => {
  h.transcriptions = [finalSegment("seg-1", "Proposed a restart of web.", "rigel-agent-1")];
  const room = fakeRoom();

  render(<VoiceSessionEffects room={room} onPills={() => {}} />);

  expect(loadSessions()[0]!.messages).toEqual([{ id: "seg-1", role: "assistant", text: "Proposed a restart of web." }]);
});

test("interim (non-final) segments are never recorded", () => {
  h.transcriptions = [interimSegment("seg-1", "restart w", "rigel-desktop")];
  const room = fakeRoom();

  render(<VoiceSessionEffects room={room} onPills={() => {}} />);

  expect(loadSessions()).toHaveLength(0);
});

test("a segment that goes interim then final is recorded exactly once", () => {
  h.transcriptions = [interimSegment("seg-1", "restart w", "rigel-desktop")];
  const room = fakeRoom();
  const { rerender } = render(<VoiceSessionEffects room={room} onPills={() => {}} />);
  expect(loadSessions()).toHaveLength(0);

  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  rerender(<VoiceSessionEffects room={room} onPills={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.messages).toHaveLength(1);
  expect(sessions[0]!.messages[0]!.text).toBe("restart web");
});

test("a later unrelated interim tick does not rewrite an already-recorded final", () => {
  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  const room = fakeRoom();
  const { rerender } = render(<VoiceSessionEffects room={room} onPills={() => {}} />);
  const firstUpdatedAt = loadSessions()[0]!.updatedAt;

  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop"), interimSegment("seg-2", "and then", "rigel-desktop")];
  rerender(<VoiceSessionEffects room={room} onPills={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.messages).toHaveLength(1);
  expect(sessions[0]!.updatedAt).toBe(firstUpdatedAt);
});

test("multiple final turns accumulate under one session entry", () => {
  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  const room = fakeRoom();
  const { rerender } = render(<VoiceSessionEffects room={room} onPills={() => {}} />);

  h.transcriptions = [
    finalSegment("seg-1", "restart web", "rigel-desktop"),
    finalSegment("seg-2", "Proposed a restart of web.", "rigel-agent-1"),
  ];
  rerender(<VoiceSessionEffects room={room} onPills={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "restart web"],
    ["assistant", "Proposed a restart of web."],
  ]);
});

test("two separate room mounts record under two separate session ids", () => {
  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  const roomA = fakeRoom();
  const { unmount } = render(<VoiceSessionEffects room={roomA} onPills={() => {}} />);
  unmount();

  h.transcriptions = [finalSegment("seg-2", "scale api to 3", "rigel-desktop")];
  const roomB = fakeRoom();
  render(<VoiceSessionEffects room={roomB} onPills={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(2);
  expect(new Set(sessions.map((s) => s.id)).size).toBe(2);
});
