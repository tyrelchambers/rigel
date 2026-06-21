/**
 * ChatPane — the always-visible right-panel chat. Mounted at the app-shell
 * level alongside the routed content column; never a route.
 *
 * Chrome mirrors ChatView.swift:
 *   - Header: "✦ Rigel" left; copy / new-chat / history buttons right.
 *   - Transcript (scrollable, pinned-bottom autoscroll).
 *   - ThinkingPane while streaming.
 *   - PaneComposer with placeholder "Ask Rigel…  (/ for commands, @ to mention a resource)".
 *   - Composer footer: model label ("Opus 4.8 · High") + "</> commands" + send button.
 *
 * Width: resizable via drag on the left edge (280–520px), persisted to
 * localStorage under key "rigel.chatPane.width".
 *
 * The chat engine (state, WS, event loop) is reused wholesale from
 * ChatPanel.tsx — only the outer shell chrome and layout differ.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Copy, SquarePen, Clock, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { BatchConfirmSheet, type BatchConfirmItem } from "@/components/BatchConfirmSheet";
import { PurgeSheet } from "@/panels/purge/PurgeSheet";
import type { ActionBlock, ActionResult } from "@/lib/api";
import { useChatConfig, useSuggestions, executeAction, useContexts } from "@/lib/api";
import { chatFeedback, visibleSummary, batchFeedback, type BatchRun } from "@/panels/chat/workloadResultReport";
import { SuggestedPromptsRow } from "@/panels/chat/SuggestedPromptsRow";
import { stripActionBlocks, type SuggestedAction } from "@/lib/actionBlocks";
import { onChatEvent, sendChat, interruptChat, subscribe, unsubscribe } from "@/lib/ws";
import { registerChatHandoff, handoffToChat } from "@/lib/chatHandoff";
import { useCluster } from "@/store/cluster";
import { MessageBubble } from "@/panels/chat/MessageBubble";
import { ThinkingPane } from "@/panels/chat/ThinkingPane";
import {
  loadModelConfig,
  saveModelConfig,
  type ModelConfig,
} from "@/panels/chat/composerModel";
import {
  loadScope,
  saveScope,
  scopeToWire,
  type ScopeSelection,
} from "@/panels/chat/composerScope";
import {
  CHAT_COMMANDS,
  commandDisplay,
} from "@/panels/chat/chatCommands";
import { buildMentions } from "@/panels/chat/mentions";
import { PaneComposer } from "./PaneComposer";
import { ChatPaneEmptyState } from "./ChatPaneEmptyState";
import { loadPaneWidth, savePaneWidth, MIN_WIDTH, MAX_WIDTH } from "./chatPaneWidth";
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
  appendToolActivity,
  applyToolResult,
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
import { RigelMark } from "@/components/RigelMark";

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
  const navigate = useNavigate();

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

  // Subscribe to deployments (all namespaces) so we can read the agent's
  // install namespace without pulling in the full useAssistant hook.
  useEffect(() => {
    subscribe("deployments", "*");
    return () => unsubscribe("deployments", "*");
  }, []);
  const agentNamespace = useCluster((s) => {
    const deps = (s.resources["deployments"] ?? {}) as Record<string, { metadata?: { name?: string; namespace?: string } }>;
    const agent = Object.values(deps).find((d) => d.metadata?.name === "rigel-assistant");
    return agent?.metadata?.namespace ?? "default";
  });

  // Model/effort selection (persisted) + @-mention candidates from the store.
  const [modelConfig, setModelConfigState] = useState<ModelConfig>(() => loadModelConfig());
  const setModelConfig = useCallback((c: ModelConfig) => {
    setModelConfigState(c);
    saveModelConfig(c);
  }, []);
  const modelConfigRef = useRef<ModelConfig>(modelConfig);
  modelConfigRef.current = modelConfig;

  // Cluster-scope selection (persisted) — tells the Helmsman which contexts to read.
  const [scopeConfig, setScopeConfig] = useState<ScopeSelection>(() => loadScope());
  const scopeConfigRef = useRef(scopeConfig);
  useEffect(() => {
    scopeConfigRef.current = scopeConfig;
    saveScope(scopeConfig);
  }, [scopeConfig]);
  const { data: contexts } = useContexts();
  const contextNames = useMemo(() => (contexts ?? []).map((c) => c.name), [contexts]);

  // Mirror sessionId into a ref so the handoff `submit` closure (registered once)
  // sends the CURRENT session id and resumes the conversation across turns.
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
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

  // AI copilot config — drives the "not configured" empty-state below and
  // disables the composer when no AI token/API key is configured. Treat the
  // loading state (chatConfig == null) as enabled to avoid a disabled flash.
  const { data: chatConfig } = useChatConfig();
  const notConfigured = chatConfig != null && !chatConfig.configured;
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
      sendChat(prompt, { ...modelConfigRef.current, sessionId: sessionIdRef.current ?? undefined, scope: scopeToWire(scopeConfigRef.current) });
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
        case "tool":
          setMessages((prev) => appendToolActivity(prev, event));
          break;
        case "toolResult":
          setMessages((prev) => applyToolResult(prev, event.toolId, event.isError, event.output));
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
    // Drop the send entirely when there's no AI token/API key: appending the
    // user bubble would leave a message that never gets a reply.
    if (!text || usageLimit || notConfigured) return;

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
    sendChat(text, { ...modelConfig, sessionId: sessionId ?? undefined, scope: scopeToWire(scopeConfig) });
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

  // Close the loop after a chat-proposed action runs: show a visible ✓/✗ summary
  // AND feed the full result back into the SAME session (no user bubble) so the
  // model knows it ran and can verify/continue. Parity with Swift executeWorkload.
  function handleActionResult(info: { action: ActionBlock; result: ActionResult; commandString: string }) {
    const title = info.action.label ?? "Action";
    setMessages((prev) => [...prev, makeMessage("system", visibleSummary(title, info.result))]);
    setIsStreaming(true);
    setIsThinking(false);
    setLiveThinking("");
    liveThinkingRef.current = "";
    const start = new Date();
    setTurnStartedAt(start);
    turnStartedAtRef.current = start;
    setIsAtBottom(true);
    isAtBottomRef.current = true;
    sendChat(chatFeedback(info.commandString, info.result), {
      ...modelConfigRef.current,
      sessionId: sessionIdRef.current ?? undefined,
      scope: scopeToWire(scopeConfigRef.current),
    });
  }

  // ── Batch actions → BatchConfirmSheet → sequential execute ────────────────
  const [pendingBatch, setPendingBatch] = useState<ActionBlock[] | null>(null);

  function handleRunBatch(suggestions: SuggestedAction[]) {
    // purge/applyManifest can't join a sequential batch (already excluded in the
    // list UI; filter defensively).
    const blocks = suggestions
      .map(toActionBlock)
      .filter((b) => b.kind !== "purge" && b.kind !== "applyManifest");
    if (blocks.length === 0) return;
    setPendingBatch(blocks);
  }

  // Run the confirmed batch sequentially, stopping at the first failure. Each
  // action shows a ▶︎ preview then a ✓/✗ summary; one combined result is fed
  // back into the session (parity with Swift executeBatch / batchFeedback).
  async function executeBatch(items: BatchConfirmItem[]) {
    setPendingBatch(null);
    setIsStreaming(true);
    setIsThinking(false);
    setLiveThinking("");
    liveThinkingRef.current = "";
    const start = new Date();
    setTurnStartedAt(start);
    turnStartedAtRef.current = start;
    setIsAtBottom(true);
    isAtBottomRef.current = true;

    const ran: BatchRun[] = [];
    let failedAt = -1;
    for (let i = 0; i < items.length; i++) {
      const { action, commandString } = items[i]!;
      setMessages((prev) => [...prev, makeMessage("system", `▶︎ ${commandString}`)]);
      let result: ActionResult;
      try {
        const resp = await executeAction(action);
        result = "code" in resp ? resp : { code: 1, stdout: "", stderr: "unexpected response" };
      } catch (e) {
        result = { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
      }
      setMessages((prev) => [...prev, makeMessage("system", visibleSummary(action.label ?? "Action", result))]);
      ran.push({ commandString, result });
      if (result.code !== 0) {
        failedAt = i;
        break;
      }
    }
    const skipped = failedAt >= 0 ? items.slice(failedAt + 1).map((it) => it.commandString) : [];
    sendChat(batchFeedback(ran, skipped), {
      ...modelConfigRef.current,
      sessionId: sessionIdRef.current ?? undefined,
      scope: scopeToWire(scopeConfigRef.current),
    });
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
          background: "var(--surface-elevated)",
          borderLeft: "1px solid #26272B",
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
            borderBottom: "1px solid #26272B",
            flexShrink: 0,
          }}
        >
          <span style={{ color: "var(--accent-primary)", display: "flex", flexShrink: 0 }}>
            <RigelMark size={18} />
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg-primary)",
              whiteSpace: "nowrap",
            }}
          >
            Rigel assistant
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
            <SquarePen size={11} style={{ color: "var(--accent-primary)" }} />
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
                color: "var(--fg-tertiary)",
                background: "var(--surface-sunken)",
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
            <ChatPaneEmptyState
              show={!!chatConfig && !chatConfig.configured && messages.length === 0}
            />
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                onAction={handleSuggestedAction}
                onRunBatch={handleRunBatch}
                onAnswer={(value) => handoffToChat(value)}
                agentNamespace={agentNamespace}
              />
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

        {/* ── "no API key" hint (above the composer) ───────────────────────── */}
        {notConfigured && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px 0",
              fontSize: 12,
              color: "var(--fg-secondary)",
              flexShrink: 0,
            }}
          >
            <span style={{ lineHeight: 1.4 }}>Add an API key to start chatting.</span>
            <button
              type="button"
              onClick={() => navigate("/settings")}
              style={{
                marginLeft: "auto",
                color: "var(--accent-primary)",
                fontWeight: 500,
                textDecoration: "none",
                whiteSpace: "nowrap",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                fontSize: "inherit",
              }}
            >
              Open Settings
            </button>
          </div>
        )}

        {/* ── Composer ─────────────────────────────────────────────────────── */}
        <PaneComposer
          ref={composerRef}
          value={inputText}
          onChange={setInputText}
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          disabled={!connected || !!usageLimit || notConfigured}
          notConfigured={notConfigured}
          modelConfig={modelConfig}
          onModelConfig={setModelConfig}
          mentionCandidates={mentionCandidates}
          scopeConfig={scopeConfig}
          onScopeConfig={setScopeConfig}
          contextNames={contextNames}
        />

        <ConfirmSheet
          action={pendingAction}
          open={!!pendingAction}
          onClose={() => setPendingAction(null)}
          onPurge={(name, namespace) =>
            setPurgeTarget({ name: name ?? "", namespace })
          }
          fromChat
          onResult={handleActionResult}
        />

        <BatchConfirmSheet
          actions={pendingBatch ?? []}
          open={!!pendingBatch}
          onClose={() => setPendingBatch(null)}
          onConfirm={executeBatch}
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
  background: "var(--surface-sunken)",
  border: "none",
  cursor: "pointer",
  color: "var(--fg-secondary)",
  flexShrink: 0,
};
