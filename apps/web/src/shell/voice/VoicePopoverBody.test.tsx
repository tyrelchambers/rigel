// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

import { VoicePopoverBody } from "./VoicePopoverBody";

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
    <VoicePopoverBody report={REPORT} pills={[]} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onEnd={vi.fn()} />,
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
    <VoicePopoverBody report={REPORT} pills={[]} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onEnd={vi.fn()} />,
  );
  expect(h.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
});
