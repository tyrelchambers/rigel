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
    action: { kind: "restart", label: "Restart web", name: "web", namespace: "default" },
    command: "kubectl rollout restart deployment/web -n default",
  };
}

function renderPopover(actions: VoiceAction[]) {
  return render(
    <VoicePopoverBody
      report={REPORT}
     
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
    <VoicePopoverBody report={REPORT} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
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
    <VoicePopoverBody report={REPORT} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
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
test("dismissing a proposal reports it rather than only dimming the card", async () => {
  const onCancel = vi.fn();
  const action = pendingAction("a1");
  render(
    <VoicePopoverBody report={REPORT} actions={[action]} onRunClick={vi.fn()} onCancel={onCancel} onEnd={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onCancel).toHaveBeenCalledWith(action);
});

test("running a proposal goes through the confirm sheet, never a spoken word", async () => {
  const onRunClick = vi.fn();
  const action = pendingAction("a1");
  render(
    <VoicePopoverBody report={REPORT} actions={[action]} onRunClick={onRunClick} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  expect(screen.queryByText(/confirm/i)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Restart web" }));
  expect(onRunClick).toHaveBeenCalledWith(action);
});

test("the blast radius is named in words in every waiting state", () => {
  const { rerender } = render(
    <VoicePopoverBody report={REPORT} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  expect(screen.getByText("reversible")).toBeInTheDocument();

  rerender(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[{ ...pendingAction("a1"), action: { kind: "deletePod", label: "Delete web-1", pod: "web-1" } }]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(screen.getByText("irreversible")).toBeInTheDocument();
});

test("a change the agent is running offers no button to press", () => {
  render(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[{ ...pendingAction("a1"), auto: true }]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(screen.getByText("Running")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restart web" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});

test("a change the agent ran reports the outcome in place of the button", () => {
  render(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[{ ...pendingAction("a1"), auto: true, done: { ok: true, summary: "ran" } }]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(screen.getByText("ran")).toBeInTheDocument();
});

const prAction = (over: Record<string, unknown> = {}) => ({
  ...pendingAction("pr1"),
  auto: true,
  command: null,
  action: {
    kind: "proposeRepoFix" as const,
    label: "Open a PR annotating web",
    name: "reddex-deploy",
    namespace: "default",
    source: "reddex-v3",
    title: "Annotate reddex-deploy with its owner",
    edit: { op: "annotate" as const, annotations: { "rigel.dev/owner": "platform" } },
  },
  ...over,
});

const cardText = () => document.body.textContent ?? "";

test("every state names the kind and the state in the same place", () => {
  render(
    <VoicePopoverBody report={REPORT} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  expect(screen.getAllByText("restart").length).toBeGreaterThan(0);
  expect(screen.getByText("needs approval")).toBeInTheDocument();
});

test("a removal says irreversible and confirms in red, a reversible change does not", () => {
  const { rerender } = render(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[{ ...pendingAction("a1"), action: { kind: "deleteResource", label: "Delete svc web", name: "web", resourceKind: "service" } }]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(screen.getByText("irreversible")).toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "Delete svc web" });
  expect(confirm.style.background).toContain("status-failed");

  rerender(
    <VoicePopoverBody report={REPORT} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  expect(screen.getByText("reversible")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Restart web" }).style.background).toContain("accent-primary");
});

test("a change the agent ran says what happened, not the word Ran", () => {
  render(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[{ ...pendingAction("a1"), auto: true, done: { ok: true, summary: "ran" } }]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(screen.getByText("done")).toBeInTheDocument();
  expect(screen.queryByText("Ran")).toBeNull();
});

test("a pull request being opened names the workload and the change, with no command", () => {
  render(
    <VoicePopoverBody report={REPORT} actions={[prAction()]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  expect(screen.getByText("opening")).toBeInTheDocument();
  expect(screen.getByText("no cluster change")).toBeInTheDocument();
  expect(cardText()).toContain("reddex-deploy in default");
  expect(cardText()).toContain("rigel.dev/owner");
  expect(cardText()).toContain("platform");
  expect(document.querySelector("pre")).toBeNull();
});

test("an opened pull request leads with the number and links out, showing no diff", () => {
  render(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[
        prAction({
          done: {
            ok: true,
            summary: "opened pull request #248",
            prUrl: "https://github.com/tyrelchambers/reddex-v3/pull/248",
            repoSlug: "tyrelchambers/reddex-v3",
          },
        }),
      ]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(screen.getByText("#248")).toBeInTheDocument();
  expect(screen.getByText("Annotate reddex-deploy with its owner")).toBeInTheDocument();
  expect(cardText()).toContain("tyrelchambers/reddex-v3");
  expect(cardText()).toContain("Nothing changed on the cluster");
  const link = screen.getByRole("link", { name: "View pull request" });
  expect(link).toHaveAttribute("href", "https://github.com/tyrelchambers/reddex-v3/pull/248");
  expect(document.querySelector("pre")).toBeNull();
});

test("a pull request that failed shows the reason in full and says nothing was pushed", () => {
  const reason = "No manifest in the repository defines deployment reddex-deploy in namespace default.";
  render(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[prAction({ done: { ok: false, summary: reason } })]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(screen.getByText(reason)).toBeInTheDocument();
  expect(screen.getByText("nothing pushed")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});

test("the command renders in the same block the confirm sheet uses, prompt and all", () => {
  render(
    <VoicePopoverBody report={REPORT} actions={[pendingAction("a1")]} onRunClick={vi.fn()} onCancel={vi.fn()} onEnd={vi.fn()} />,
  );
  const block = document.querySelector("pre");
  expect(block?.textContent).toBe("$ kubectl rollout restart deployment/web -n default");
  // The binary is emphasised separately from the flags, which is the whole
  // point of sharing the component rather than restyling a <code>.
  expect(block?.querySelectorAll("span").length).toBeGreaterThan(3);
});

test("a proposal with no command names its target instead of rendering an empty block", () => {
  render(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[{ id: "a1", action: { kind: "purge", label: "Remove memos", name: "memos", namespace: "default" }, command: null }]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  expect(screen.getByText("purge memos in default")).toBeInTheDocument();
  expect(document.querySelector("pre")).toBeNull();
});

test("a long action label truncates instead of pushing Dismiss out of the card", () => {
  render(
    <VoicePopoverBody
      report={REPORT}
     
      actions={[
        {
          id: "a1",
          action: { kind: "deletePod", label: "Delete pod canada-hires-web-6f8c94d7-qm2xz", pod: "canada-hires-web-6f8c94d7-qm2xz" },
          command: "kubectl delete pod canada-hires-web-6f8c94d7-qm2xz -n default",
        },
      ]}
      onRunClick={vi.fn()}
      onCancel={vi.fn()}
      onEnd={vi.fn()}
    />,
  );
  const run = screen.getByRole("button", { name: "Delete pod canada-hires-web-6f8c94d7-qm2xz" });
  expect(run.className).toContain("truncate");
  expect(screen.getByRole("button", { name: "Dismiss" }).className).toContain("shrink-0");
});
