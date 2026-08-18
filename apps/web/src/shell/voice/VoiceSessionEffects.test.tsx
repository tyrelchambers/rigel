// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Room } from "livekit-client";
import { useCluster } from "@/store/cluster";
import { loadSessions } from "@/panels/chat/chatHistory";

interface FakeTranscript {
  text: string;
  participantInfo?: { identity: string };
  streamInfo?: { id: string; attributes?: Record<string, string> };
}

interface FakeDataMessage {
  payload: Uint8Array;
  topic?: string;
  from?: { identity: string };
}

const h = vi.hoisted(() => ({
  transcriptions: [] as FakeTranscript[],
  channels: [] as { topic: string; cb?: (msg: unknown) => void }[],
}));
vi.mock("@livekit/components-react", () => ({
  useTranscriptions: () => h.transcriptions,
  // Stands in for the real hook's topic filtering: a frame is only handed to
  // the handler registered for its own topic.
  useDataChannel: (topic: string, cb?: (msg: unknown) => void) => {
    h.channels.push({ topic, cb });
    return { isSending: false, send: async () => {}, message: undefined };
  },
}));

import {
  ACTION_RESULT_TOPIC,
  ACTION_TOPIC,
  AGENT_STATE_TOPIC,
  publishJson,
  toReportedAgentState,
  toVoiceActionFrame,
  VoiceSessionEffects,
  type VoiceActionFrame,
} from "./VoiceSessionEffects";

const AGENT = "rigel-agent";

/** A click-tier proposal shaped exactly the way apps/voice/src/agent.ts sends it. */
const CLICK_FRAME = {
  id: "call-1",
  tier: "click",
  action: { kind: "deleteResource", label: "Delete pod web-1", name: "web-1", namespace: "default" },
  command: "kubectl delete pod web-1 -n default",
};

/** Hands one frame to the live handler for that topic, as the room would. */
function deliver(topic: string, body: unknown, identity: string | undefined) {
  const msg: FakeDataMessage = {
    payload: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    topic,
    from: identity === undefined ? undefined : { identity },
  };
  const forTopic = h.channels.filter((c) => c.topic === topic);
  const live = forTopic[forTopic.length - 1];
  act(() => live?.cb?.(msg));
}

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
  h.channels.length = 0;
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
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  expect(frames(room, "rigel.state")).toEqual([{ activeContext: "prod" }]);
});

test("publishes again when the active context changes", () => {
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  expect(frames(room, "rigel.state")).toHaveLength(1);

  useCluster.getState().applySwitch("staging", null);
  expect(frames(room, "rigel.state")).toEqual([{ activeContext: null }, { activeContext: "staging" }]);
});

test("does not republish when an unrelated store field changes", () => {
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  const before = publishData.mock.calls.length;

  useCluster.getState().setNamespaceFilter("kube-system");
  expect(publishData.mock.calls).toHaveLength(before);
});

test("stops publishing after unmount", () => {
  const room = fakeRoom();
  const { unmount } = render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  const publishData = room.localParticipant.publishData as ReturnType<typeof vi.fn>;
  unmount();
  const before = publishData.mock.calls.length;

  useCluster.getState().applySwitch("staging", null);
  expect(publishData.mock.calls).toHaveLength(before);
});

test("publishes the cluster's resource names as keyterms on mount", () => {
  useCluster.setState({ resources: RESOURCES });
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  expect(frames(room, "rigel.keyterms")).toEqual([
    { names: ["web", "cert-manager", "web-7f9b64c8d-x2x4p"] },
  ]);
});

test("publishes again when the resources change", () => {
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  expect(frames(room, "rigel.keyterms")).toEqual([{ names: [] }]);

  useCluster.setState({ resources: RESOURCES });
  expect(frames(room, "rigel.keyterms")).toHaveLength(2);
  expect(frames(room, "rigel.keyterms")[1]).toEqual({
    names: ["web", "cert-manager", "web-7f9b64c8d-x2x4p"],
  });
});

test("a resource update that leaves the names alone does not republish", () => {
  useCluster.setState({ resources: RESOURCES });
  const room = fakeRoom();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  expect(frames(room, "rigel.keyterms")).toHaveLength(1);

  useCluster.setState({
    resources: {
      ...RESOURCES,
      deployments: {
        ...RESOURCES.deployments,
        "default/web": { metadata: { uid: "u-web", name: "web", namespace: "default" }, spec: { replicas: 3 }, status: { readyReplicas: 3 } },
      },
    },
  });
  expect(frames(room, "rigel.keyterms")).toHaveLength(1);
});

test("renders nothing", () => {
  const room = fakeRoom();
  const { container } = render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  expect(container.innerHTML).toBe("");
});

test("a spoken resource name publishes its summary and becomes a pill", () => {
  useCluster.setState({ resources: RESOURCES });
  h.transcriptions = [{ text: "what's up with cert manager", participantInfo: { identity: "rigel-desktop" } }];
  const room = fakeRoom();
  const pills = pillCollector();

  render(<VoiceSessionEffects room={room} onPills={pills.onPills} onAction={() => {}} onAgentState={() => {}} />);

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
  const { rerender } = render(<VoiceSessionEffects room={room} onPills={pills.onPills} onAction={() => {}} onAgentState={() => {}} />);
  expect(frames(room, "rigel.context")).toHaveLength(1);

  h.transcriptions = [...h.transcriptions, { text: "and cert manager again", participantInfo: { identity: "rigel-desktop" } }];
  rerender(<VoiceSessionEffects room={room} onPills={pills.onPills} onAction={() => {}} onAgentState={() => {}} />);

  expect(frames(room, "rigel.context")).toHaveLength(1);
  expect(pills.names()).toEqual(["cert-manager"]);
});

test("what the agent says back never pins a resource", () => {
  useCluster.setState({ resources: RESOURCES });
  h.transcriptions = [{ text: "cert manager is healthy", participantInfo: { identity: "rigel-agent-1" } }];
  const room = fakeRoom();
  const pills = pillCollector();

  render(<VoiceSessionEffects room={room} onPills={pills.onPills} onAction={() => {}} onAgentState={() => {}} />);

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

  render(<VoiceSessionEffects room={room} onPills={pills.onPills} onAction={() => {}} onAgentState={() => {}} />);

  expect(frames(room, "rigel.context")).toHaveLength(8);
  expect(pills.names()).toEqual(["svc-2", "svc-3", "svc-4", "svc-5", "svc-6", "svc-7"]);
});

test("a final user segment is recorded into chat history", () => {
  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  const room = fakeRoom();

  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.title).toBe("Voice session");
  expect(sessions[0]!.messages.map((m) => [m.role, m.text])).toEqual([["user", "restart web"]]);
});

test("a final agent segment is recorded as an assistant message", () => {
  h.transcriptions = [finalSegment("seg-1", "Proposed a restart of web.", "rigel-agent-1")];
  const room = fakeRoom();

  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);

  expect(loadSessions()[0]!.messages).toEqual([{ id: "seg-1", role: "assistant", text: "Proposed a restart of web." }]);
});

test("interim (non-final) segments are never recorded", () => {
  h.transcriptions = [interimSegment("seg-1", "restart w", "rigel-desktop")];
  const room = fakeRoom();

  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);

  expect(loadSessions()).toHaveLength(0);
});

test("a segment that goes interim then final is recorded exactly once", () => {
  h.transcriptions = [interimSegment("seg-1", "restart w", "rigel-desktop")];
  const room = fakeRoom();
  const { rerender } = render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  expect(loadSessions()).toHaveLength(0);

  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  rerender(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.messages).toHaveLength(1);
  expect(sessions[0]!.messages[0]!.text).toBe("restart web");
});

test("a later unrelated interim tick does not rewrite an already-recorded final", () => {
  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  const room = fakeRoom();
  const { rerender } = render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  const firstUpdatedAt = loadSessions()[0]!.updatedAt;

  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop"), interimSegment("seg-2", "and then", "rigel-desktop")];
  rerender(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.messages).toHaveLength(1);
  expect(sessions[0]!.updatedAt).toBe(firstUpdatedAt);
});

test("multiple final turns accumulate under one session entry", () => {
  h.transcriptions = [finalSegment("seg-1", "restart web", "rigel-desktop")];
  const room = fakeRoom();
  const { rerender } = render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);

  h.transcriptions = [
    finalSegment("seg-1", "restart web", "rigel-desktop"),
    finalSegment("seg-2", "Proposed a restart of web.", "rigel-agent-1"),
  ];
  rerender(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);

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
  const { unmount } = render(<VoiceSessionEffects room={roomA} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);
  unmount();

  h.transcriptions = [finalSegment("seg-2", "scale api to 3", "rigel-desktop")];
  const roomB = fakeRoom();
  render(<VoiceSessionEffects room={roomB} onPills={() => {}} onAction={() => {}} onAgentState={() => {}} />);

  const sessions = loadSessions();
  expect(sessions).toHaveLength(2);
  expect(new Set(sessions.map((s) => s.id)).size).toBe(2);
});

test("a click-tier frame from the agent reaches onAction intact", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  deliver(ACTION_TOPIC, CLICK_FRAME, AGENT);

  expect(onAction).toHaveBeenCalledTimes(1);
  expect(onAction.mock.calls[0]![0]).toEqual(CLICK_FRAME);
});

test("a rigel.action frame from a non-agent identity is ignored", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  deliver(ACTION_TOPIC, CLICK_FRAME, "rigel-phone-abc");

  expect(onAction).not.toHaveBeenCalled();
});

test("a rigel.action frame from the desktop itself is ignored", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  deliver(ACTION_TOPIC, CLICK_FRAME, "rigel-desktop");

  expect(onAction).not.toHaveBeenCalled();
});

test("a rigel.action frame with no resolvable sender fails closed", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  deliver(ACTION_TOPIC, CLICK_FRAME, undefined);

  expect(onAction).not.toHaveBeenCalled();
});

test("an identity that merely starts with the wrong prefix is ignored", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  deliver(ACTION_TOPIC, CLICK_FRAME, "not-rigel-agent");

  expect(onAction).not.toHaveBeenCalled();
});

test("a click-tier frame carrying a null command still reaches onAction", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  deliver(ACTION_TOPIC, { ...CLICK_FRAME, command: null }, AGENT);

  expect(onAction.mock.calls[0]![0]).toMatchObject({ id: "call-1", command: null });
});

test("a rigel.action.result frame from the agent arrives as a done patch", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  deliver(ACTION_RESULT_TOPIC, { id: "call-1", ok: true, summary: "ran" }, AGENT);

  expect(onAction.mock.calls[0]![0]).toMatchObject({ id: "call-1", done: { ok: true, summary: "ran" } });
});

test("a rigel.action.result frame from a non-agent identity is ignored", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  deliver(ACTION_RESULT_TOPIC, { id: "call-1", ok: true, summary: "ran" }, "rigel-phone-abc");

  expect(onAction).not.toHaveBeenCalled();
});

test("a malformed action frame is dropped rather than thrown", () => {
  const room = fakeRoom();
  const onAction = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={onAction} onAgentState={() => {}} />);

  expect(() => deliver(ACTION_TOPIC, "{not json", AGENT)).not.toThrow();
  expect(onAction).not.toHaveBeenCalled();
});

test("toVoiceActionFrame keeps a null command as null", () => {
  const frame = toVoiceActionFrame(ACTION_TOPIC, { ...CLICK_FRAME, command: null });
  expect(frame).toEqual({ ...CLICK_FRAME, command: null } as VoiceActionFrame);
});

test("toVoiceActionFrame rejects a frame with an unknown tier", () => {
  expect(toVoiceActionFrame(ACTION_TOPIC, { ...CLICK_FRAME, tier: "auto" })).toBeNull();
});

test("toVoiceActionFrame rejects a frame with no action block", () => {
  expect(toVoiceActionFrame(ACTION_TOPIC, { id: "call-1", tier: "click", command: null })).toBeNull();
});

test("toVoiceActionFrame rejects a frame with no id", () => {
  expect(toVoiceActionFrame(ACTION_TOPIC, { tier: "click", action: { kind: "restart" }, command: null })).toBeNull();
});

test("toVoiceActionFrame rejects an unknown topic", () => {
  expect(toVoiceActionFrame("rigel.state", CLICK_FRAME)).toBeNull();
});

test("toVoiceActionFrame treats a result frame with no ok field as a failure", () => {
  expect(toVoiceActionFrame(ACTION_RESULT_TOPIC, { id: "call-1" })?.done).toEqual({ ok: false, summary: "" });
});

test("a state report from the agent reaches onAgentState", () => {
  const room = fakeRoom();
  const onAgentState = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={onAgentState} />);

  deliver(AGENT_STATE_TOPIC, { state: "thinking" }, AGENT);

  expect(onAgentState).toHaveBeenCalledExactlyOnceWith("thinking");
});

test("a state report from a phone in the room is ignored", () => {
  const room = fakeRoom();
  const onAgentState = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={onAgentState} />);

  deliver(AGENT_STATE_TOPIC, { state: "listening" }, "rigel-phone-abc");

  expect(onAgentState).not.toHaveBeenCalled();
});

test("a state report with no resolvable sender fails closed", () => {
  const room = fakeRoom();
  const onAgentState = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={onAgentState} />);

  deliver(AGENT_STATE_TOPIC, { state: "listening" }, undefined);

  expect(onAgentState).not.toHaveBeenCalled();
});

test("a malformed state report is dropped rather than thrown", () => {
  const room = fakeRoom();
  const onAgentState = vi.fn();
  render(<VoiceSessionEffects room={room} onPills={() => {}} onAction={() => {}} onAgentState={onAgentState} />);

  expect(() => deliver(AGENT_STATE_TOPIC, "{not json", AGENT)).not.toThrow();
  deliver(AGENT_STATE_TOPIC, { state: "melting" }, AGENT);
  expect(onAgentState).not.toHaveBeenCalled();
});

test("toReportedAgentState accepts only the five states a session can be in", () => {
  for (const state of ["initializing", "idle", "listening", "thinking", "speaking"]) {
    expect(toReportedAgentState({ state })).toBe(state);
  }
  expect(toReportedAgentState({ state: "failed" })).toBeNull();
  expect(toReportedAgentState({ state: "connecting" })).toBeNull();
  expect(toReportedAgentState({ state: 3 })).toBeNull();
  expect(toReportedAgentState({})).toBeNull();
  expect(toReportedAgentState(null)).toBeNull();
  expect(toReportedAgentState("listening")).toBeNull();
});
