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
import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Copy, SquarePen, Clock, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { PurgeSheet } from "@/panels/purge/PurgeSheet";
import type { ActionBlock } from "@/lib/api";
import { stripActionBlocks, type SuggestedAction } from "@/lib/actionBlocks";
import { onChatEvent, sendChat, interruptChat } from "@/lib/ws";
import { registerChatHandoff } from "@/lib/chatHandoff";
import { useCluster } from "@/store/cluster";
import { MessageBubble } from "@/panels/chat/MessageBubble";
import { ThinkingPane } from "@/panels/chat/ThinkingPane";
import {
  appendTextDelta,
  stampThinking,
  makeMessage,
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [liveThinking, setLiveThinking] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<Date | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [usageLimit, setUsageLimit] = useState<string | null>(null);
  const [autoFocusComposer, setAutoFocusComposer] = useState(false);

  const connected = useCluster((s) => s.connected);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
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
      sendChat(prompt);
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
    sendChat(text);
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
    setMessages([]);
    setSessionId(null);
    setUsageLimit(null);
    setInputText("");
    setIsStreaming(false);
    setIsThinking(false);
    setLiveThinking("");
    liveThinkingRef.current = "";
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

          {/* Chat history (placeholder icon — full history sheet deferred) */}
          <button
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
            }}
          >
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

        {/* ── Composer ─────────────────────────────────────────────────────── */}
        <PaneComposer
          ref={composerRef}
          value={inputText}
          onChange={setInputText}
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          disabled={!connected || !!usageLimit}
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
}

/**
 * Composer chrome matching ChatComposer.swift:
 * - Rounded container with a multiline field.
 * - Footer row: model label + "</> commands" chip on the left; send/stop on the right.
 */
function PaneComposer({
  ref,
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled,
}: PaneComposerProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = (ref ?? internalRef) as React.RefObject<HTMLTextAreaElement>;

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = LINE_HEIGHT * MAX_LINES;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value, textareaRef]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
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
      }}
    >
      {/* Rounded container */}
      <div
        style={{
          background: "#0A0A0C",
          borderRadius: 10,
          border: "1px solid #2A2A2A",
          overflow: "hidden",
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={PLACEHOLDER}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
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
          }}
        />
        {/* Control row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px 8px",
          }}
        >
          {/* Model label */}
          <span
            style={{
              fontSize: 10,
              color: "#6B6B73",
              background: "#141417",
              padding: "2px 7px",
              borderRadius: 100,
              border: "1px solid #2A2A2A",
              whiteSpace: "nowrap",
              fontWeight: 500,
            }}
          >
            Opus 4.8 · High
          </span>
          {/* Commands pill */}
          <button
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10,
              color: "#6B6B73",
              background: "#141417",
              padding: "2px 7px",
              borderRadius: 100,
              border: "1px solid #2A2A2A",
              cursor: "pointer",
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
            title="Browse chat commands"
            onClick={() => {
              // Insert "/" to open command hints — same as picking from the menu
              if (textareaRef.current && !value.startsWith("/")) {
                onChange("/" + value);
                textareaRef.current.focus();
              }
            }}
          >
            <span style={{ fontFamily: "monospace", fontSize: 9 }}>&lt;/&gt;</span>
            <span>commands</span>
          </button>

          <div style={{ flex: 1 }} />

          {/* Send / Stop */}
          {isStreaming ? (
            <button
              onClick={onStop}
              aria-label="Stop"
              style={sendBtnStyle("#EF4444")}
            >
              <span style={{ display: "block", width: 10, height: 10, background: "#fff", borderRadius: 1 }} />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!canSend}
              aria-label="Send"
              style={sendBtnStyle(canSend ? "#A855F7" : "#2A2A2A")}
            >
              {/* Arrow-up icon */}
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
