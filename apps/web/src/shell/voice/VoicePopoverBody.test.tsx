// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentReport } from "./VoiceMark";
import type { VoiceAction } from "./VoiceSessionEffects";

interface FakeTranscript {
  text: string;
  participantInfo?: { identity: string };
  streamInfo?: { id: string };
}

const h = vi.hoisted(() => ({
  transcriptions: [] as FakeTranscript[],
  scrollToEnd: vi.fn(),
  reducedMotion: false,
}));

vi.mock("@livekit/components-react", () => ({
  RoomContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
  useVoiceAssistant: () => ({ state: "listening", audioTrack: undefined }),
  useTranscriptions: () => h.transcriptions,
  useTrackVolume: () => 0,
  useMultibandTrackVolume: () => [],
  useLocalParticipant: () => ({ microphoneTrack: undefined, localParticipant: undefined }),
}));

// Real geometry (scrollHeight/scrollTop) is unmeasurable in jsdom, so the
// library's own near-bottom/follow mechanics can't be exercised here. Stub it
// down to a pass-through render plus a spyable scrollToEnd, which isolates
// the one thing this file owns: *when* and *how* a reveal is requested.
vi.mock("@shadcn/react/message-scroller", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => children;
  return {
    MessageScroller: {
      Provider: passthrough,
      Root: passthrough,
      Viewport: passthrough,
      Content: passthrough,
      Item: passthrough,
    },
    useMessageScroller: () => ({ scrollToEnd: h.scrollToEnd, scrollToStart: vi.fn(), scrollToMessage: vi.fn() }),
  };
});

import { VoicePopoverBody, transcriptTurns } from "./VoicePopoverBody";

const REPORT: AgentReport = { state: "listening", timedOut: false };

function stubMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function pendingAction(id: string): VoiceAction {
  return {
    id,
    tier: "voice",
    action: { kind: "restart", label: "Restart web", name: "web", namespace: "default" },
    command: "kubectl rollout restart deployment/web -n default",
    receivedAt: Date.now(),
  };
}

function renderPopover(actions: VoiceAction[]) {
  return render(
    <VoicePopoverBody
      report={REPORT}
      pills={[]}
      actions={actions}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
}

beforeEach(() => {
  h.transcriptions = [];
  h.scrollToEnd.mockClear();
  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
});

test("shows the empty-state placeholder with no transcript yet", () => {
  renderPopover([]);
  expect(screen.getByText("Say something. Your words appear here as you speak.")).toBeInTheDocument();
});

test("renders transcript turns from both sides of the conversation", () => {
  h.transcriptions = [
    { text: "restart the web deployment", participantInfo: { identity: "operator" }, streamInfo: { id: "s1" } },
    { text: "Restarting web now.", participantInfo: { identity: "rigel-agent-worker" }, streamInfo: { id: "s2" } },
  ];
  renderPopover([]);
  expect(screen.getByText("restart the web deployment")).toBeInTheDocument();
  expect(screen.getByText("Restarting web now.")).toBeInTheDocument();
});

test("does not force a reveal for an action that is already resolved", () => {
  renderPopover([{ ...pendingAction("a1"), done: { ok: true, summary: "ran" } }]);
  expect(h.scrollToEnd).not.toHaveBeenCalled();
});

test("forces a smooth reveal the moment a voice confirmation arms", () => {
  const { rerender } = renderPopover([]);
  expect(h.scrollToEnd).not.toHaveBeenCalled();

  rerender(
    <VoicePopoverBody report={REPORT} pills={[]} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
  expect(h.scrollToEnd).toHaveBeenLastCalledWith({ behavior: "smooth" });
});

test("does not re-reveal for the same confirmation on unrelated re-renders", () => {
  const { rerender } = renderPopover([pendingAction("a1")]);
  expect(h.scrollToEnd).toHaveBeenCalledTimes(1);

  rerender(
    <VoicePopoverBody
      report={REPORT}
      pills={[]}
      actions={[pendingAction("a1")]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(h.scrollToEnd).toHaveBeenCalledTimes(1);
});

test("reveals again for a second confirmation later in the same session", () => {
  const { rerender } = renderPopover([pendingAction("a1")]);
  expect(h.scrollToEnd).toHaveBeenCalledTimes(1);

  rerender(
    <VoicePopoverBody
      report={REPORT}
      pills={[]}
      actions={[{ ...pendingAction("a1"), done: { ok: true, summary: "ran" } }, pendingAction("a2")]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(h.scrollToEnd).toHaveBeenCalledTimes(2);
  expect(h.scrollToEnd).toHaveBeenLastCalledWith({ behavior: "smooth" });
});

test("reveals instantly instead of smoothly when the reader prefers reduced motion", () => {
  stubMatchMedia(true);
  const { rerender } = renderPopover([]);

  rerender(
    <VoicePopoverBody report={REPORT} pills={[]} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  expect(h.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
});

// ---------------------------------------------------------------------------
// transcriptTurns
// ---------------------------------------------------------------------------
const seg = (text: string, identity: string, id: string): FakeTranscript => ({
  text,
  participantInfo: { identity },
  streamInfo: { id },
});

test("consecutive segments from one speaker become a single turn", () => {
  expect(
    transcriptTurns([
      seg("Reddex deploy has", "rigel-agent-worker", "s1"),
      seg("three of three replicas ready.", "rigel-agent-worker", "s2"),
    ]),
  ).toEqual([{ id: "s1", fromAgent: true, text: "Reddex deploy has three of three replicas ready." }]);
});

test("a change of speaker starts a new turn", () => {
  expect(
    transcriptTurns([
      seg("how is reddex", "operator", "s1"),
      seg("Reddex deploy is", "rigel-agent-worker", "s2"),
      seg("healthy.", "rigel-agent-worker", "s3"),
      seg("restart it", "operator", "s4"),
    ]),
  ).toEqual([
    { id: "s1", fromAgent: false, text: "how is reddex" },
    { id: "s2", fromAgent: true, text: "Reddex deploy is healthy." },
    { id: "s4", fromAgent: false, text: "restart it" },
  ]);
});

test("blank segments neither render nor split a turn", () => {
  expect(
    transcriptTurns([
      seg("scale web", "operator", "s1"),
      seg("   ", "operator", "s2"),
      seg("to three", "operator", "s3"),
    ]),
  ).toEqual([{ id: "s1", fromAgent: false, text: "scale web to three" }]);
});

test("the turn keeps the first segment's id, so a streaming tail does not remount it", () => {
  const first = transcriptTurns([seg("Reddex deploy", "rigel-agent-worker", "s1")]);
  const later = transcriptTurns([
    seg("Reddex deploy", "rigel-agent-worker", "s1"),
    seg("is healthy.", "rigel-agent-worker", "s2"),
  ]);
  expect(later[0]?.id).toBe(first[0]?.id);
});

test("a fragmented agent answer renders as one bubble, not one per segment", () => {
  h.transcriptions = [
    seg("Canada hires web", "rigel-agent-worker", "s1"),
    seg("is running one replica.", "rigel-agent-worker", "s2"),
  ];
  renderPopover([]);
  expect(screen.getByText("Canada hires web is running one replica.")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// referenced-resources accordion + proposal card
// ---------------------------------------------------------------------------
const PILLS = [
  { id: "u-1", kind: "deployment" as const, name: "canada-hires-web", context: "1/1 ready" },
  { id: "u-2", kind: "pod" as const, name: "canada-hires-web-6f8c94", context: "Running" },
];

test("referenced resources open as an accordion, with the count on the header", async () => {
  render(
    <VoicePopoverBody report={REPORT} pills={PILLS} actions={[]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  const trigger = screen.getByRole("button", { name: /Referenced this session/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("canada-hires-web")).toBeInTheDocument();

  await userEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("the header keeps the count while the list is collapsed", async () => {
  render(
    <VoicePopoverBody report={REPORT} pills={PILLS} actions={[]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Referenced this session/ }));
  expect(screen.getByText("2")).toBeInTheDocument();
});

test("cancelling a pending confirmation reports it rather than only dimming the card", async () => {
  const onCancel = vi.fn();
  const action = pendingAction("a1");
  render(
    <VoicePopoverBody report={REPORT} pills={[]} actions={[action]} onRunClick={vi.fn()} onCancel={onCancel} onEnd={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledWith(action);
});

test("the pending card offers the desktop as the fallback route", async () => {
  const onRunClick = vi.fn();
  const action = pendingAction("a1");
  render(
    <VoicePopoverBody report={REPORT} pills={[]} actions={[action]} onRunClick={onRunClick} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Run on desktop" }));
  expect(onRunClick).toHaveBeenCalledWith(action);
});
