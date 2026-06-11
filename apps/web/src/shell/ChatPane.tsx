/**
 * ChatPane — the always-visible right-panel chat. Mounted at the app-shell
 * level alongside the routed content column; never a route.
 *
 * Chrome mirrors ChatView.swift:
 *   - Header: "✦ Helmsman" left; copy / new-chat / history buttons right.
 *   - Transcript (scrollable, pinned-bottom autoscroll).
 *   - ThinkingPane while streaming.
 *   - ChatComposer with placeholder "Ask Helmsman…  (/ for commands, @ to mention a resource)".
 *   - Composer footer: model label ("Opus 4.8 · High") + "</> commands" + send button.
 *
 * Width: resizable via drag on the left edge (280–520px), persisted to
 * localStorage under key "helmsman.chatPane.width".
 *
 * The chat engine (state, WS, event loop) is reused wholesale from
 * ChatPanel.tsx — only the outer shell chrome and layout differ.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Copy, SquarePen, Clock, ArrowDown, Box, Layers, Server, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { PurgeSheet } from "@/panels/purge/PurgeSheet";
import type { ActionBlock } from "@/lib/api";
import { useChatConfig, useSuggestions } from "@/lib/api";
import { SuggestedPromptsRow } from "@/panels/chat/SuggestedPromptsRow";
import { Link } from "react-router";
import { stripActionBlocks, type SuggestedAction } from "@/lib/actionBlocks";
import { onChatEvent, sendChat, interruptChat } from "@/lib/ws";
import { registerChatHandoff, handoffToChat } from "@/lib/chatHandoff";
import { useCluster } from "@/store/cluster";
import { MessageBubble } from "@/panels/chat/MessageBubble";
import { ThinkingPane } from "@/panels/chat/ThinkingPane";
import {
  CLAUDE_MODELS,
  CLAUDE_EFFORTS,
  loadModelConfig,
  saveModelConfig,
  modelLabel,
  type ModelConfig,
} from "@/panels/chat/composerModel";
import {
  CHAT_COMMANDS,
  commandDisplay,
  commandInsertion,
  filterCommands,
  type ChatCommandSpec,
} from "@/panels/chat/chatCommands";
import {
  buildMentions,
  filterMentions,
  MENTION_KIND_LABEL,
  type MentionCandidate,
  type MentionKind,
} from "@/panels/chat/mentions";
import {
  loadMostRecent,
  loadSessions,
  upsertSession,
  deleteSession,
  deriveTitle,
  type ChatHistoryEntry,
} from "@/panels/chat/chatHistory";
import { ChatHistorySheet } from "@/panels/chat/ChatHistorySheet";
import {
  appendTextDelta,
  stampThinking,
  makeMessage,
  newId,
  isNearBottom,
  showJumpToNewest,
  elapsedSeconds,
  transcript,
  shortSessionId,
  toActionBlock,
  TAIL_SCROLL_THROTTLE_MS,
} from "@/panels/chat/chatLogic";
import type { ChatEvent, ChatMessage } from "@/panels/chat/types";

// ── Resize persistence ────────────────────────────────────────────────────────

const PANE_WIDTH_KEY = "helmsman.chatPane.width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 360;

function loadPaneWidth(): number {
  try {
    const raw = localStorage.getItem(PANE_WIDTH_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (isNaN(n)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function savePaneWidth(w: number): void {
  try {
    localStorage.setItem(PANE_WIDTH_KEY, String(w));
  } catch {
    // ignore
  }
}

// ── ChatPane ──────────────────────────────────────────────────────────────────

/**
 * Optional external send handle — Overview "Investigate cluster" and similar
 * call this to inject a message into the pane.
 */
export interface ChatPaneHandle {
  send: (prompt: string) => void;
}

interface ChatPaneProps {
  /** Ref exposed so other panels can inject messages. */
  handleRef?: React.MutableRefObject<ChatPaneHandle | null>;
}

export default function ChatPane({ handleRef }: ChatPaneProps) {
  // ── Width / resize state ──────────────────────────────────────────────────
  const [paneWidth, setPaneWidth] = useState<number>(() => loadPaneWidth());
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  function handleResizeMouseDown(e: React.MouseEvent) {
    resizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = paneWidth;
    e.preventDefault();
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizingRef.current) return;
      // Dragging left edge: moving LEFT increases width, moving RIGHT decreases.
      const delta = startXRef.current - e.clientX;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
      setPaneWidth(next);
    }
    function onMouseUp() {
      if (resizingRef.current) {
        resizingRef.current = false;
        setPaneWidth((w) => {
          savePaneWidth(w);
          return w;
        });
      }
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // ── Chat state (mirrors ChatPanel.tsx) ────────────────────────────────────
  // Restore the most recent conversation from localStorage on first render so a
  // page refresh keeps the transcript. Read once into a ref to keep the lazy
  // initializers consistent.
  const bootRef = useRef<ChatHistoryEntry | null | undefined>(undefined);
  if (bootRef.current === undefined) bootRef.current = loadMostRecent();
  const boot = bootRef.current;

  const [messages, setMessages] = useState<ChatMessage[]>(boot?.messages ?? []);
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(boot?.sessionId ?? null);
  // Stable id for the active conversation (used as the history-entry key).
  const [conversationId, setConversationId] = useState<string>(boot?.id ?? newId());
  const createdAtRef = useRef<number>(boot?.createdAt ?? Date.now());

  // Chat history modal.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<ChatHistoryEntry[]>([]);
  const [liveThinking, setLiveThinking] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<Date | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [usageLimit, setUsageLimit] = useState<string | null>(null);
  const [autoFocusComposer, setAutoFocusComposer] = useState(false);

  const connected = useCluster((s) => s.connected);
  const resources = useCluster((s) => s.resources);

  // Model/effort selection (persisted) + @-mention candidates from the store.
  const [modelConfig, setModelConfigState] = useState<ModelConfig>(() => loadModelConfig());
  const setModelConfig = useCallback((c: ModelConfig) => {
    setModelConfigState(c);
    saveModelConfig(c);
  }, []);
  const modelConfigRef = useRef<ModelConfig>(modelConfig);
  modelConfigRef.current = modelConfig;
  const mentionCandidates = useMemo(() => buildMentions(resources), [resources]);

  // Persist the active conversation once each turn settles (not mid-stream, to
  // avoid a write per token). Runs on mount too, re-saving the restored chat.
  useEffect(() => {
    if (isStreaming || messages.length === 0) return;
    upsertSession({
      id: conversationId,
      title: deriveTitle(messages),
      createdAt: createdAtRef.current,
      updatedAt: Date.now(),
      sessionId,
      messages,
    });
  }, [messages, isStreaming, sessionId, conversationId]);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // AI copilot config — drives the "not configured" empty-state below.
  const { data: chatConfig } = useChatConfig();
  // Cluster-aware suggestion chips above the composer.
  const { data: suggestions } = useSuggestions();
  const liveThinkingRef = useRef("");
  const turnStartedAtRef = useRef<Date | null>(null);
  const isAtBottomRef = useRef(true);
  const lastTailScroll = useRef(0);

  isAtBottomRef.current = isAtBottom;

  const scrollToBottom = useCallback((smooth: boolean) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }, []);

  // ── Expose send handle + global handoff ───────────────────────────────────
  // The handle (for App-level callers) and the global registry (for any panel)
  // share one submit: it appends the user message to the transcript and streams
  // the reply in this always-visible pane — so handoffs never navigate.
  useEffect(() => {
    const submit = (prompt: string) => {
      if (!prompt.trim()) return;
      setMessages((prev) => [...prev, makeMessage("user", prompt)]);
      setIsStreaming(true);
      setIsThinking(false);
      setLiveThinking("");
      liveThinkingRef.current = "";
      const start = new Date();
      setTurnStartedAt(start);
      turnStartedAtRef.current = start;
      setIsAtBottom(true);
      isAtBottomRef.current = true;
      sendChat(prompt, modelConfigRef.current);
    };
    if (handleRef) handleRef.current = { send: submit };
    registerChatHandoff(submit);
  }, [handleRef]);

  // ── WebSocket chat event handling ─────────────────────────────────────────
  useEffect(() => {
    const handle = (event: ChatEvent) => {
      switch (event.type) {
        case "thinking":
          liveThinkingRef.current += event.text ?? "";
          setLiveThinking(liveThinkingRef.current);
          setIsThinking(true);
          break;
        case "text":
          setMessages((prev) => appendTextDelta(prev, event.text ?? ""));
          break;
        case "done": {
          const start = turnStartedAtRef.current;
          const secs = start ? elapsedSeconds(start) : 0;
          const thinking = liveThinkingRef.current;
          setMessages((prev) => stampThinking(prev, thinking, secs));
          setIsStreaming(false);
          setIsThinking(false);
          setLiveThinking("");
          liveThinkingRef.current = "";
          setUsageLimit(null);
          break;
        }
        case "error":
          setMessages((prev) => [
            ...prev,
            makeMessage("system", `⚠︎ ${event.text ?? "The session ended unexpectedly."}`),
          ]);
          setIsStreaming(false);
          setIsThinking(false);
          setLiveThinking("");
          liveThinkingRef.current = "";
          setAutoFocusComposer(true);
          break;
        case "session":
          setSessionId(event.sessionId);
          break;
        case "usageLimit":
          setUsageLimit(event.text ?? "Claude usage limit reached.");
          setMessages((prev) => [
            ...prev,
            makeMessage("system", `⚠︎ ${event.text ?? "Claude usage limit reached."}`),
          ]);
          setIsStreaming(false);
          break;
        case "sessionEnded":
          setMessages((prev) => [
            ...prev,
            makeMessage(
              "system",
              event.text ?? "⚠︎ Claude subprocess is no longer running. Message not sent.",
            ),
          ]);
          setIsStreaming(false);
          setSessionId(null);
          setAutoFocusComposer(true);
          break;
      }
    };
    return onChatEvent(handle);
  }, []);

  // ── Scroll: new message ───────────────────────────────────────────────────
  const messageCount = messages.length;
  useEffect(() => {
    if (isAtBottomRef.current) scrollToBottom(true);
  }, [messageCount, scrollToBottom]);

  // ── Scroll: streaming tail (throttled) ───────────────────────────────────
  const lastText = messages[messages.length - 1]?.text ?? "";
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const now = Date.now();
    if (now - lastTailScroll.current < TAIL_SCROLL_THROTTLE_MS) return;
    lastTailScroll.current = now;
    scrollToBottom(false);
  }, [lastText, scrollToBottom]);

  // ── Scroll: turn end catch-up ─────────────────────────────────────────────
  useEffect(() => {
    if (!isStreaming && isAtBottomRef.current) scrollToBottom(true);
  }, [isStreaming, scrollToBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setIsAtBottom(isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
  }

  // ── ⌘L / Ctrl+L focuses the composer ─────────────────────────────────────
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "l" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Auto-focus ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (autoFocusComposer) {
      composerRef.current?.focus();
      setAutoFocusComposer(false);
    }
  }, [autoFocusComposer]);

  // ── Send / interrupt ──────────────────────────────────────────────────────
  function handleSend() {
    const text = inputText.trim();
    if (!text || usageLimit) return;

    // Client-handled slash commands (mirror SlashCommand): these never reach the
    // model. Unknown / arg-bearing commands fall through to Claude as a prompt.
    if (text === "/clear") {
      startNewChat();
      return;
    }
    if (text === "/help" || text === "/?") {
      setInputText("");
      const help =
        "Available commands:\n" +
        CHAT_COMMANDS.map((c) => `- \`${commandDisplay(c)}\` — ${c.description}`).join("\n");
      setMessages((prev) => [...prev, makeMessage("system", help)]);
      return;
    }

    setMessages((prev) => [...prev, makeMessage("user", text)]);
    setInputText("");
    setIsStreaming(true);
    setIsThinking(false);
    setLiveThinking("");
    liveThinkingRef.current = "";
    const start = new Date();
    setTurnStartedAt(start);
    turnStartedAtRef.current = start;
    setIsAtBottom(true);
    isAtBottomRef.current = true;
    sendChat(text, modelConfig);
  }

  function handleStop() {
    interruptChat();
    setIsStreaming(false);
    setIsThinking(false);
    setLiveThinking("");
    liveThinkingRef.current = "";
    setMessages((prev) => [...prev, makeMessage("system", "⏹ Stopped by user.")]);
  }

  function startNewChat() {
    // The previous conversation stays saved; this just begins a fresh one.
    setConversationId(newId());
    createdAtRef.current = Date.now();
    setMessages([]);
    setSessionId(null);
    setUsageLimit(null);
    setInputText("");
    setIsStreaming(false);
    setIsThinking(false);
    setLiveThinking("");
    liveThinkingRef.current = "";
  }

  // ── Chat history modal ─────────────────────────────────────────────────────
  function openHistory() {
    setHistoryEntries(loadSessions());
    setHistoryOpen(true);
  }
  function resumeSession(e: ChatHistoryEntry) {
    interruptChat();
    setConversationId(e.id);
    createdAtRef.current = e.createdAt;
    setMessages(e.messages);
    setSessionId(e.sessionId);
    setUsageLimit(null);
    setInputText("");
    setIsStreaming(false);
    setIsThinking(false);
    setLiveThinking("");
    liveThinkingRef.current = "";
    setHistoryOpen(false);
    setIsAtBottom(true);
    isAtBottomRef.current = true;
  }
  function deleteHistoryEntry(e: ChatHistoryEntry) {
    deleteSession(e.id);
    setHistoryEntries(loadSessions());
    if (e.id === conversationId) startNewChat();
  }

  async function copyConversation() {
    const text = transcript(messages, stripActionBlocks);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  }

  // ── Action blocks → ConfirmSheet / PurgeSheet ─────────────────────────────
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<{ name: string; namespace: string } | null>(null);

  function handleSuggestedAction(action: SuggestedAction) {
    const block = toActionBlock(action);
    if (block.kind === "purge") {
      setPurgeTarget({
        name: block.name ?? block.deployment ?? "",
        namespace: block.namespace ?? "default",
      });
      return;
    }
    setPendingAction(block);
  }

  const shortId = shortSessionId(sessionId);
  const showThinkingPane = isStreaming && isThinking;

  return (
    <>
      {/* Drag handle — 6px zone on the left edge of the pane */}
      <div
        onMouseDown={handleResizeMouseDown}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: "col-resize",
          zIndex: 10,
          background: "transparent",
        }}
        title="Drag to resize chat pane"
        aria-hidden
      />

      <div
        style={{
          width: paneWidth,
          minWidth: paneWidth,
          maxWidth: paneWidth,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#141417",
          borderLeft: "1px solid #1A1A1A",
          flexShrink: 0,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "10px 14px",
            borderBottom: "1px solid #1A1A1A",
            flexShrink: 0,
          }}
        >
          <Sparkles size={13} style={{ color: "#A855F7", flexShrink: 0 }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#FFFFFF",
              whiteSpace: "nowrap",
            }}
          >
            Helmsman
          </span>

          <div style={{ flex: 1 }} />

          {/* Copy conversation */}
          <button
            onClick={copyConversation}
            disabled={messages.length === 0}
            title="Copy conversation"
            style={headerBtnStyle}
            aria-label="Copy conversation"
          >
            <Copy size={11} />
          </button>

          {/* New chat */}
          <button
            onClick={startNewChat}
            title="New chat"
            style={headerBtnStyle}
            aria-label="New chat"
          >
            <SquarePen size={11} style={{ color: "#A855F7" }} />
          </button>

          {/* Chat history */}
          <button
            onClick={openHistory}
            title="Chat history"
            style={headerBtnStyle}
            aria-label="Chat history"
          >
            <Clock size={11} />
          </button>

          {shortId && (
            <span
              style={{
                marginLeft: 4,
                fontFamily: "ui-monospace, monospace",
                fontSize: 10,
                color: "#6B6B73",
                background: "#0A0A0C",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              {shortId}
            </span>
          )}
        </header>

        {/* ── Message list ─────────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            style={{
              height: "100%",
              overflowY: "auto",
              overflowX: "hidden",
              padding: "14px 14px 0",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {chatConfig && !chatConfig.configured && messages.length === 0 && (
              <div
                style={{
                  margin: "8px 0",
                  padding: "14px",
                  borderRadius: 10,
                  background: "#141417",
                  border: "1px solid #2A2A2A",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Sparkles size={15} style={{ color: "#A855F7" }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#FFFFFF" }}>
                    The Helmsman copilot isn't set up yet
                  </span>
                </div>
                <span style={{ fontSize: 12, color: "#A1A1AA", lineHeight: 1.5 }}>
                  Chat needs a Claude subscription token. Run{" "}
                  <code style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#A855F7" }}>
                    claude setup-token
                  </code>{" "}
                  and add it in Settings — the rest of the app works without it.
                </span>
                <Link
                  to="/settings"
                  style={{
                    alignSelf: "flex-start",
                    marginTop: 2,
                    padding: "5px 12px",
                    borderRadius: 6,
                    background: "#A855F7",
                    color: "#FFFFFF",
                    fontSize: 12,
                    fontWeight: 500,
                    textDecoration: "none",
                  }}
                >
                  Open Settings
                </Link>
              </div>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} onAction={handleSuggestedAction} />
            ))}
            <div ref={bottomRef} style={{ height: 14 }} />
          </div>

          {showJumpToNewest(isAtBottom, messages.length) && (
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => {
                setIsAtBottom(true);
                scrollToBottom(true);
              }}
              style={{
                position: "absolute",
                bottom: 12,
                left: "50%",
                transform: "translateX(-50%)",
              }}
              aria-label="Jump to newest"
            >
              <ArrowDown />
            </Button>
          )}
        </div>

        {/* ── Thinking pane ────────────────────────────────────────────────── */}
        {showThinkingPane && (
          <ThinkingPane liveThinking={liveThinking} turnStartedAt={turnStartedAt} />
        )}

        {/* ── Suggestion chips (cluster-aware) ─────────────────────────────── */}
        {!isStreaming && (
          <SuggestedPromptsRow
            prompts={suggestions ?? []}
            onTap={(p) => handoffToChat(p.prompt)}
          />
        )}

        {/* ── Composer ─────────────────────────────────────────────────────── */}
        <PaneComposer
          ref={composerRef}
          value={inputText}
          onChange={setInputText}
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          disabled={!connected || !!usageLimit}
          modelConfig={modelConfig}
          onModelConfig={setModelConfig}
          mentionCandidates={mentionCandidates}
        />

        <ConfirmSheet
          action={pendingAction}
          open={!!pendingAction}
          onClose={() => setPendingAction(null)}
          onPurge={(name, namespace) =>
            setPurgeTarget({ name: name ?? "", namespace })
          }
        />

        <PurgeSheet
          target={purgeTarget}
          open={purgeTarget !== null}
          onClose={() => setPurgeTarget(null)}
        />

        <ChatHistorySheet
          open={historyOpen}
          entries={historyEntries}
          onResume={resumeSession}
          onDelete={deleteHistoryEntry}
          onClose={() => setHistoryOpen(false)}
        />
      </div>
    </>
  );
}

// ── Header button style ───────────────────────────────────────────────────────

const headerBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 4,
  background: "#0A0A0C",
  border: "none",
  cursor: "pointer",
  color: "#A1A1AA",
  flexShrink: 0,
};

// ── PaneComposer ─────────────────────────────────────────────────────────────

const PLACEHOLDER = "Ask Helmsman…  (/ for commands, @ to mention a resource)";
const LINE_HEIGHT = 20;
const MAX_LINES = 8;

interface PaneComposerProps {
  ref?: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  modelConfig: ModelConfig;
  onModelConfig: (c: ModelConfig) => void;
  mentionCandidates: MentionCandidate[];
}

type ComposerTrigger =
  | { kind: "command"; query: string; items: ChatCommandSpec[] }
  | { kind: "mention"; query: string; start: number; items: MentionCandidate[] };

const MENTION_ICON: Record<MentionKind, typeof Box> = {
  pod: Box,
  deployment: Layers,
  node: Server,
};

/**
 * Composer chrome matching ChatComposer.swift:
 * - Rounded container with a multiline field.
 * - Footer: model picker + "</> commands" chip on the left; send/stop on the right.
 * - `/` opens a command typeahead; `@` opens a resource mention picker
 *   (↑/↓ to move, Enter/Tab to pick, Esc to dismiss).
 */
function PaneComposer({
  ref,
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled,
  modelConfig,
  onModelConfig,
  mentionCandidates,
}: PaneComposerProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = (ref ?? internalRef) as React.RefObject<HTMLTextAreaElement>;
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = LINE_HEIGHT * MAX_LINES;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value, textareaRef]);

  // Active "/" (leading) or "@<token>" trigger from the text up to the caret.
  const trigger = useMemo<ComposerTrigger | null>(() => {
    const before = value.slice(0, caret);
    if (value.startsWith("/") && !/\s/.test(before)) {
      const query = before.slice(1);
      const items = filterCommands(query);
      return items.length ? { kind: "command", query, items } : null;
    }
    const at = before.lastIndexOf("@");
    if (at >= 0) {
      const prevOk = at === 0 || /\s/.test(before[at - 1]);
      const frag = before.slice(at + 1);
      if (prevOk && !/\s/.test(frag)) {
        const items = filterMentions(mentionCandidates, frag);
        return items.length ? { kind: "mention", query: frag, start: at, items } : null;
      }
    }
    return null;
  }, [value, caret, mentionCandidates]);

  const triggerKey = trigger ? `${trigger.kind}:${trigger.query}` : "";
  useEffect(() => {
    setSel(0);
    setDismissed(false);
  }, [triggerKey]);

  const popoverOpen = trigger !== null && !dismissed;

  function syncCaret() {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }
  function setCaretAt(p: number) {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(p, p);
        setCaret(p);
      }
    });
  }

  function pickCommand(spec: ChatCommandSpec) {
    const sp = value.indexOf(" ");
    const rest = sp >= 0 ? value.slice(sp + 1) : "";
    const ins = commandInsertion(spec);
    onChange(ins + rest);
    setCaretAt(ins.length);
  }
  function pickMention(c: MentionCandidate) {
    if (trigger?.kind !== "mention") return;
    const ins = `${c.name} `;
    onChange(value.slice(0, trigger.start) + ins + value.slice(caret));
    setCaretAt(trigger.start + ins.length);
  }
  function selectCurrent() {
    if (!trigger) return;
    if (trigger.kind === "command") pickCommand(trigger.items[sel]);
    else pickMention(trigger.items[sel]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (popoverOpen && trigger) {
      const n = trigger.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s - 1 + n) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectCurrent();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Escape") {
      if (modelOpen) {
        e.preventDefault();
        setModelOpen(false);
        return;
      }
      if (isStreaming) {
        e.preventDefault();
        onStop();
      }
      return;
    }
    if (e.key === "Enter") {
      if (e.shiftKey) return;
      e.preventDefault();
      onSend();
    }
  }

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div
      style={{
        padding: "8px 12px 10px",
        borderTop: "1px solid #1A1A1A",
        background: "#141417",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {/* `/` command or `@` mention popover (above the input) */}
      {popoverOpen && trigger && (
        <div style={popoverStyle}>
          {trigger.kind === "command"
            ? trigger.items.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickCommand(c);
                  }}
                  onMouseEnter={() => setSel(i)}
                  style={popRowStyle(i === sel)}
                >
                  <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, fontWeight: 600, color: "#FFFFFF" }}>
                    {commandDisplay(c)}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      color: i === sel ? "rgba(255,255,255,0.8)" : "#6B6B73",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {c.description}
                  </span>
                </button>
              ))
            : trigger.items.map((c, i) => {
                const Icon = MENTION_ICON[c.kind];
                return (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickMention(c);
                    }}
                    onMouseEnter={() => setSel(i)}
                    style={popRowStyle(i === sel)}
                  >
                    <Icon style={{ width: 12, height: 12, color: i === sel ? "#FFFFFF" : "#A1A1AA", flexShrink: 0 }} />
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 12,
                        fontWeight: 500,
                        color: "#FFFFFF",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.name}
                    </span>
                    {c.namespace && (
                      <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: i === sel ? "rgba(255,255,255,0.7)" : "#6B6B73", whiteSpace: "nowrap" }}>
                        {c.namespace}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono, monospace)", fontSize: 9, fontWeight: 600, letterSpacing: 0.5, color: i === sel ? "rgba(255,255,255,0.7)" : "#6B6B73" }}>
                      {MENTION_KIND_LABEL[c.kind]}
                    </span>
                  </button>
                );
              })}
        </div>
      )}

      {/* Model picker menu — rendered outside the rounded container so its
          upward-opening menu isn't clipped by the container's overflow:hidden. */}
      {modelOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 25 }} onClick={() => setModelOpen(false)} />
          <div style={modelMenuStyle}>
            <div style={modelSectionLabel}>MODEL</div>
            {CLAUDE_MODELS.map((m) => (
              <button key={m.id} type="button" onClick={() => onModelConfig({ ...modelConfig, model: m.id })} style={modelRowStyle(modelConfig.model === m.id)}>
                {modelConfig.model === m.id ? <Check style={checkStyle} /> : <span style={{ width: 12 }} />}
                {m.name}
              </button>
            ))}
            <div style={{ ...modelSectionLabel, marginTop: 6 }}>EFFORT</div>
            {CLAUDE_EFFORTS.map((ef) => (
              <button key={ef.id} type="button" onClick={() => onModelConfig({ ...modelConfig, effort: ef.id })} style={modelRowStyle(modelConfig.effort === ef.id)}>
                {modelConfig.effort === ef.id ? <Check style={checkStyle} /> : <span style={{ width: 12 }} />}
                {ef.name}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Rounded container */}
      <div style={{ background: "#0A0A0C", borderRadius: 10, border: "1px solid #2A2A2A", overflow: "hidden" }}>
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={PLACEHOLDER}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onKeyDown={handleKeyDown}
          style={textareaStyle}
        />
        {/* Control row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px 8px", position: "relative" }}>
          {/* Model picker */}
          <button type="button" onClick={() => setModelOpen((o) => !o)} title="Choose model and reasoning effort" style={{ ...pillStyle, cursor: "pointer" }}>
            {modelLabel(modelConfig)}
          </button>

          {/* Commands pill — opens the / popover */}
          <button
            type="button"
            style={{ ...pillStyle, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
            title="Browse chat commands"
            onClick={() => {
              if (!value.startsWith("/")) onChange("/" + value);
              setCaretAt(1);
            }}
          >
            <span style={{ fontFamily: "monospace", fontSize: 9 }}>&lt;/&gt;</span>
            <span>commands</span>
          </button>

          <div style={{ flex: 1 }} />

          {/* Send / Stop */}
          {isStreaming ? (
            <button onClick={onStop} aria-label="Stop" style={sendBtnStyle("#EF4444")}>
              <span style={{ display: "block", width: 10, height: 10, background: "#fff", borderRadius: 1 }} />
            </button>
          ) : (
            <button onClick={onSend} disabled={!canSend} aria-label="Send" style={sendBtnStyle(canSend ? "#A855F7" : "#2A2A2A")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ display: "block" }}>
                <path d="M6 10V2M6 2L2 6M6 2l4 4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  background: "transparent",
  border: "none",
  outline: "none",
  resize: "none",
  color: "#FFFFFF",
  fontSize: 13,
  lineHeight: `${LINE_HEIGHT}px`,
  maxHeight: LINE_HEIGHT * MAX_LINES,
  padding: "10px 10px 0",
  fontFamily: "var(--font-geist, system-ui, sans-serif)",
};

const pillStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#6B6B73",
  background: "#141417",
  padding: "2px 7px",
  borderRadius: 100,
  border: "1px solid #2A2A2A",
  whiteSpace: "nowrap",
  fontWeight: 500,
};

const popoverStyle: React.CSSProperties = {
  position: "absolute",
  left: 12,
  right: 12,
  bottom: "100%",
  marginBottom: 6,
  background: "#141417",
  border: "1px solid #2A2A2A",
  borderRadius: 8,
  boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
  overflow: "hidden",
  zIndex: 30,
  padding: 4,
  maxHeight: 280,
  overflowY: "auto",
};

function popRowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    textAlign: "left",
    padding: "6px 8px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    background: active ? "#A855F7" : "transparent",
  };
}

const modelMenuStyle: React.CSSProperties = {
  position: "absolute",
  left: 12,
  bottom: "100%",
  marginBottom: 6,
  zIndex: 30,
  background: "#141417",
  border: "1px solid #2A2A2A",
  borderRadius: 8,
  boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
  padding: 6,
  width: 200,
};

const modelSectionLabel: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: 0.5,
  color: "#6B6B73",
  padding: "3px 8px 2px",
};

function modelRowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    textAlign: "left",
    padding: "5px 8px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    background: active ? "#1C1C22" : "transparent",
    color: active ? "#FFFFFF" : "#A1A1AA",
    fontSize: 12,
    fontWeight: 500,
  };
}

const checkStyle: React.CSSProperties = { width: 12, height: 12, color: "#A855F7", flexShrink: 0 };

function sendBtnStyle(bg: string): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: 7,
    background: bg,
    border: "none",
    cursor: "pointer",
    flexShrink: 0,
    transition: "background 120ms",
  };
}
