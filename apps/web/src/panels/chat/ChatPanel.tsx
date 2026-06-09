import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Copy, SquarePen, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import { stripActionBlocks, type SuggestedAction } from "@/lib/actionBlocks";
import { onChatEvent, sendChat, interruptChat } from "@/lib/ws";
import { useCluster } from "@/store/cluster";
import { MessageBubble } from "./MessageBubble";
import { ThinkingPane } from "./ThinkingPane";
import { ChatComposer } from "./ChatComposer";
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
} from "./chatLogic";
import type { ChatEvent, ChatMessage } from "./types";

export default function ChatPanel() {
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Refs mirror state for use inside the WS callback without re-subscribing.
  const liveThinkingRef = useRef("");
  const turnStartedAtRef = useRef<Date | null>(null);
  const isAtBottomRef = useRef(true);
  const lastTailScroll = useRef(0);

  isAtBottomRef.current = isAtBottom;

  const scrollToBottom = useCallback((smooth: boolean) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }, []);

  // --- WebSocket chat event handling ---------------------------------------
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
          setUsageLimit(null); // successful turn clears the sticky badge
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

  // --- Scroll: new message (count change) ----------------------------------
  const messageCount = messages.length;
  useEffect(() => {
    if (isAtBottomRef.current) scrollToBottom(true);
  }, [messageCount, scrollToBottom]);

  // --- Scroll: streaming tail (throttled, only when pinned) ----------------
  const lastText = messages[messages.length - 1]?.text ?? "";
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const now = Date.now();
    if (now - lastTailScroll.current < TAIL_SCROLL_THROTTLE_MS) return;
    lastTailScroll.current = now;
    scrollToBottom(false);
  }, [lastText, scrollToBottom]);

  // --- Scroll: turn end catch-up -------------------------------------------
  useEffect(() => {
    if (!isStreaming && isAtBottomRef.current) scrollToBottom(true);
  }, [isStreaming, scrollToBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setIsAtBottom(isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
  }

  // --- Send / interrupt ----------------------------------------------------
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
      /* clipboard unavailable; no-op */
    }
  }

  // --- Action blocks → ConfirmSheet ----------------------------------------
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  function handleSuggestedAction(action: SuggestedAction) {
    setPendingAction(toActionBlock(action));
  }

  const shortId = shortSessionId(sessionId);
  const showThinkingPane = isStreaming && isThinking;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <Sparkles className="size-4 text-primary" />
        <h1 className="text-sm font-semibold">Helmsman</h1>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={copyConversation}
            disabled={messages.length === 0}
            aria-label="Copy conversation"
          >
            <Copy />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={startNewChat} aria-label="New chat">
            <SquarePen />
          </Button>
          {shortId && (
            <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {shortId}
            </span>
          )}
        </div>
      </header>

      {/* Message list */}
      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-auto px-4">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} onAction={handleSuggestedAction} />
          ))}
          <div ref={bottomRef} />
        </div>

        {showJumpToNewest(isAtBottom, messages.length) && (
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => {
              setIsAtBottom(true);
              scrollToBottom(true);
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow"
            aria-label="Jump to newest"
          >
            <ArrowDown />
          </Button>
        )}
      </div>

      {/* Thinking pane (slides in while streaming + thinking) */}
      {showThinkingPane && (
        <ThinkingPane liveThinking={liveThinking} turnStartedAt={turnStartedAt} />
      )}

      {/* Composer */}
      <ChatComposer
        value={inputText}
        onChange={setInputText}
        onSend={handleSend}
        onStop={handleStop}
        onInterrupt={handleStop}
        isStreaming={isStreaming}
        disabled={!connected || !!usageLimit}
        autoFocus={autoFocusComposer}
        onFocusChange={(f) => !f && setAutoFocusComposer(false)}
      />

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}
