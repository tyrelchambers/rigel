# Chat Panel — Normative Behavior Spec (Web Port)

**Source of Truth:** Sources/Helmsman/Chat/ (Swift app) | See also docs/parity/contracts.md § 1 for action-block protocol.

---

## Layout & Structure

### High-level Hierarchy
```
ChatPanel (root container)
├── Header (title, buttons, session ID)
├── MessageList (ScrollView, accumulates messages)
│   └── MessageBubble[] (role-specific styling, markdown, action buttons, thinking trail)
├── ThinkingPane (shown only while streaming)
└── ChatComposer (textarea + control row)
```

---

## Columns & Fields

### Message Model (`ChatMessage`)

| Field | Type | Source | Display Scope | Notes |
|-------|------|--------|---------------|-------|
| `id` | UUID | Auto-generated | Internal tracking | Unique per message; used for scroll anchoring. |
| `role` | `"user"` \| `"assistant"` \| `"system"` | Inbound event or local action | Bubble role icon & label | Determines background, icon, label: user→person icon, assistant→sparkles, system→gear. |
| `text` | String | Accumulated `textDelta` events or local messages | Rendered as markdown (assistant only) or plain text (user/system) | Action/question blocks are parsed out and not shown in `text`. |
| `thinking` | String \| null | Stamped on from `thinkingDelta` events at turn end | Collapsible "Thought for Ns" disclosure in bubble | Empty string → no thinking trail shown. |
| `thinkingSeconds` | Integer \| null | Calculated from `turnStartedAt` to turn end | Label in thinking disclosure | Shown as "Thought for {n}s" only when truthy. |
| `tool` | ToolInvocation \| null | Deferred (not in MVP scope) | Separate tool-invocation card | Nil for all messages in MVP. |

### Header Fields

| Field | Display | Source | Behavior |
|-------|---------|--------|----------|
| "Helmsman" title + sparkles icon | Left side, fixed | Hardcoded | Identification. |
| "Copy conversation" button (doc.on.doc) | Right side | `transcript()` of all messages | Copies role-labeled conversation to clipboard; action blocks hidden, role labels included. |
| "New chat" button (square.and.pencil) | Right side | Local state | Calls `startNewChat()`; clears messages, session ID, history entry. |
| "Chat history" button (clock.arrow.circlepath) | Right side | Out-of-scope for MVP | Deferred: do NOT build in web port. |
| Session ID (first 8 chars) | Far right, monospace tag | `sessionId` from system init | Copied to clip on `/chat` route mount; persists across turns until new chat. |

---

## User Actions & Exact Behavior

### Composer Input & Send

| User Action | Exact Behavior |
|-------------|---|
| Type into textarea (multiline, max 8 lines) | Input text bound to `inputText` state. Placeholder: "Ask Helmsman…  (/ for commands, @ to mention a resource)". Up/Dn arrows scroll history (deferred) or navigate popovers if open. Tab commits popover selection if open. |
| Press Enter | If `/` popover or `@` mention popover is visible, commits highlighted item. Else if Shift+Enter, inserts newline (default field behavior). Else (plain Enter) sends the message. |
| Press Escape | If popover open, close it. Else if streaming, interrupt the session. Else ignored. |
| Click Send button (arrow.up icon) or Cmd+Enter | Validates: text must not be empty after trim. Sends `text.trim()` to WebSocket as `{type:"chat",prompt}`. Sets `isStreaming=true`, appends user message to `messages[]`. |
| Click Stop button (shown only when streaming) | Calls interrupt() on session. Sets `isStreaming=false`, appends system message "⏹ Stopped by user.", resets thinking state. |

### Scroll Behavior

| Trigger | Behavior |
|---------|----------|
| New message appended (count changes) | Auto-scroll to bottom only if currently pinned to bottom (threshold: 24px slack). If scrolled up, stay pinned to scroll position until user taps "jump to newest" or scrolls to bottom manually. |
| Streaming text arrives (last message text changes) | Throttled tail-scroll (min 0.1s gap) to smooth-follow token arrival without pinning user to bottom on interrupt. |
| Turn ends (isStreaming → false) | Final catch-up scroll to bottom, animated, respecting the pinned state. |
| User scrolls up while streaming | Unpins auto-scroll; content keeps arriving without yanking view. Re-pin only on manual return to bottom or "jump to newest" tap. |
| Jump-to-newest button visible | Only shown when `!isAtBottom && messages.length > 0`. Tapping scrolls to `messages.last()`. |

### Message Rendering

#### Assistant Messages (with Action Block Parsing)
- **Input:** `message.text` (raw markdown + fenced action/question blocks).
- **Parse:** `SuggestedAction.parse(text)` returns `(display, actions[], questions[])`.
  - Extract fenced ` ```action ` and ` ```question ` blocks (JSON).
  - Strip blocks from `display` output (not shown as code).
  - Leave other code fences (` ```bash `, ` ```yaml `, etc.) intact in display.
- **Render:**
  - `display` as markdown (via react-markdown + remark-gfm).
  - `actions[]` → one button per action (see Action Button Rendering below).
  - `questions[]` → clarifying question UI (deferred, out of scope for MVP).
  - Thinking trail (if `thinking` is non-empty) → collapsible "Thought for Ns" disclosure above text.

#### User Messages
- Plain text (no markdown), selectable, with "Edit & resend" context menu option.

#### System Messages
- Plain text, icon = gear, label = "System" (uppercase, tracking 0.5).

### Action Button Rendering

**Container:** `SuggestedActionList` (shown below message content if `actions.length > 0`).

| Component | Rendering |
|-----------|-----------|
| **Each action button** | Label from `action.label` (string). Icon from `action.kind` (e.g., restart→arrow.clockwise, scale→arrow.up.arrow.down). Background: accent color. Hover/active state per design system. |
| **Tap action button** | Calls `onSuggestedAction(action)` callback; parent (ChatPanel) opens `ConfirmSheet` with that action. |
| **2+ actions in message** | Show a "Run selected" batch button (appears only if 2+ actions). Tapping opens checkboxes to select multiple, then runs via `onRunActions(selected[])`. Deferred for MVP; single-action flow only. |

### Thinking Pane (Shown While Streaming)

| Element | Source | Behavior |
|---------|--------|----------|
| **Status line** | `liveThinking` non-empty → `isThinking=true` | Rotating verb ("Thinking", "Investigating", "Reasoning", "Inspecting", "Working" on 2.5s cycle). Spinner icon (pulse animation). Elapsed seconds from `turnStartedAt`. Hint: "· esc to interrupt". Disclosure chevron (only clickable if thinking non-empty). |
| **Reasoning body** | `liveThinking` text | Collapsible. Max height 90px with fade mask. Auto-scrolls to tail on each delta arrival. Italic, tertiary foreground, selectable. |
| **Visibility** | `isStreaming && ` waiting for any thinking delta | Shown immediately when turn starts; hidden if thinking never arrives. Slides up (transition) when shown/hidden. |

---

## Edge Cases & Empty/Error States

| State | Trigger | Display |
|-------|---------|---------|
| **No messages yet** | Initial load | Empty message list. Composer enabled. Suggested prompts (deferred) shown. |
| **Streaming in progress** | After send, before turn end | "Stop" button in composer. ThinkingPane visible if thinking arrived. Message list shows partial text accumulating. |
| **Usage limit hit** | Server emits usageLimit event | System message "⚠︎ Claude usage limit reached (resets HH:MM)…". Sticky badge (cleared on next successful turn). Session stays alive; send disabled until limit clears. |
| **Session crashed / subprocess died** | Server error or stderr | System message "⚠︎ Claude subprocess is no longer running. Message not sent." `isStreaming=false`. Input focused. Session=null. |
| **Stale resumed session** | `resumeHistory()` with sessionId that had no real output | System message "⚠︎ Saved session was stale — cleared. Restart the app to start fresh." Clear sessionId. |
| **Connection lost** | WebSocket close | Chat UI remains visible, input disabled, error toast (handled by cluster store). |
| **Empty composer input** | Text is whitespace-only | Send button disabled. |

---

## WebSocket Transport Contract

### Client → Server

**Message type:** `{type: "chat", prompt: string}`

```
{
  "type": "chat",
  "prompt": "What pods are failing?"
}
```

### Server → Client (Streaming)

**Message type:** `{type: "chat", event: ChatEvent}` where `ChatEvent` is:

```typescript
type ChatEvent = 
  | {type: "thinking", text: string}     // Thinking delta
  | {type: "text", text: string}         // Text delta
  | {type: "done"}                       // Turn end (no text field)
  | {type: "error", text: string}        // Error message
```

**Streaming Semantics:**
- Thinking and text can interleave.
- `type:"done"` signals turn end (no more deltas coming).
- `type:"error"` is terminal; connection may close after.
- All `text` fields are deltas (accumulated by client).

**Example flow:**
```
→ {type:"chat", prompt:"Summarize"}
← {type:"chat", event:{type:"thinking", text:"Let me analyze"}}
← {type:"chat", event:{type:"thinking", text:" the pods"}}
← {type:"chat", event:{type:"text", text:"Here are"}}
← {type:"chat", event:{type:"text", text:" the pods"}}
← {type:"chat", event:{type:"done"}}
```

---

## Action Block Protocol (Fenced Parsing)

**Regex:** `/```action\s*\n([\s\S]*?)\n```/g`

**Parse:** Extract JSON from each matched group, decode into `SuggestedAction` (see contracts.md § 1).

**Kinds:** restart, scale, rollback, setEnv, setImage, setResources, pause, resume, deletePod, deleteWorkload, cordon, uncordon, drain, suspendCronJob, resumeCronJob, triggerCronJob, createNamespace, deleteNamespace, deleteResource, purge, command.

**Example in message:**
```
Here's what I recommend:

```action
{"label":"Restart web","kind":"restart","name":"web","namespace":"default"}
```

This will...
```

**Rendered as:** Prose "Here's what I recommend: This will..." + button "Restart web" → taps open ConfirmSheet.

---

## React Component API

### ChatPanel (Main Component)

```tsx
export function ChatPanel() {
  // Hooks
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [liveThinking, setLiveThinking] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<Date | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [lastTailScroll, setLastTailScroll] = useState<Date>(new Date(0));
  const [inputFocused, setInputFocused] = useState(false);
  
  // WebSocket listener setup
  useEffect(() => {
    // Connect & listen to {type:"chat",event} messages
    // Dispatch to handleChatEvent()
  }, []);
  
  // Send chat
  function sendChat(text: string): void {
    // Trim, validate, append user message, set isStreaming=true, send via WS
  }
  
  // Handle streaming events
  function handleChatEvent(event: ChatEvent): void {
    // Accumulate thinking/text, manage isStreaming, stamp thinking on turn end
  }
  
  // Scroll handling
  function scrollToBottomIfPinned(): void {
    // If isAtBottom, scroll to last message; else no-op
  }
}
```

---

## Type Definitions

```typescript
type ChatMessage = {
  id: string; // UUID
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  thinkingSeconds?: number;
  tool?: ToolInvocation; // Not in MVP
}

type ChatEvent = 
  | {type: "thinking", text: string}
  | {type: "text", text: string}
  | {type: "done"}
  | {type: "error", text: string}

type SuggestedAction = {
  label: string;
  kind: string; // See contracts.md § 1
  name?: string;
  namespace?: string;
  replicas?: number;
  env?: Record<string, string>;
  container?: string;
  image?: string;
  requests?: string;
  limits?: string;
  resourceKind?: string;
  args?: string[];
  destructive?: boolean;
  // + pod, node, deployment, deployment (back-compat alias)
}
```

---

## Out of Scope for MVP (Deferred)

- **Slash commands** (`/clear`, `/ask-claude`, etc.) — SwiftUI's `SlashCommand` + registry.
- **Mention picker** (`@pod-name`, `@deployment-name`) — Swift's `MentionCandidate` + index.
- **Chat history persistence sheet** — Swift's `ChatHistorySheet`, SessionStore.history upsert logic.
- **Suggested prompts row** — dynamically built from cluster state; refresh on 5s timer.
- **Right-click "Ask Claude" context handoff** — SwiftUI context menu → `sendHandoff()` with summary.
- **Model config picker** — `ClaudeModelConfig`, model/effort selectors in composer control row.
- **Tool invocation cards** — ToolInvocation rendering in message flow.
- **Clarifying questions** — ClarifyingQuestion fencing, multi-option display, batch submit.
- **Chat resumption** — Restore sessionId from SessionStore history; `resumeHistory()` flow.

---

## Acceptance Criteria

### Functional
1. **Send & stream:** User types prompt, hits Enter, sees assistant message accumulate in real-time.
2. **Markdown rendering:** Assistant text renders as markdown (bold, italic, code blocks, lists). Code fences like ` ```bash ` are preserved.
3. **Action blocks:** Fenced ` ```action ` JSON is extracted; each action renders as a button below message. Tapping opens ConfirmSheet showing the exact kubectl command.
4. **Thinking:** When Claude uses extended thinking, thinking text streams in live, shown in collapsible pane with elapsed-seconds timer. At turn end, it folds into a "Thought for Ns" disclosure in the message.
5. **Scroll:** Autoscroll follows new messages only if pinned to bottom. Scrolling up unpins it. Jump-to-newest button appears when scrolled up.
6. **Session persistence:** Session ID shown in header (first 8 chars). Survives conversation turns until "New chat" is clicked.
7. **Stop/interrupt:** Pressing Escape or clicking Stop button halts streaming, appends "⏹ Stopped by user." message.

### Test Coverage
- Action block extraction with malformed JSON (skipped).
- Thinking accumulation and stamping on turn end.
- Scroll pinning logic (viewport near-bottom detection).
- Markdown rendering with embedded code fences.
- WebSocket message handling (thinking, text, done, error events).

---

## Existing Infrastructure to Reuse

1. **ConfirmSheet** (`apps/web/src/components/ConfirmSheet.tsx`) — Opens on action-button tap; shows kubectl command preview; mutate via `useAction()`.
2. **lib/api.ts** — `ActionBlock` type, `useAction()` hook, `fetchPreviewCommand()` for preview.
3. **lib/ws.ts** — `connectCluster()` already listens to socket messages; extend to handle `{type:"chat", event}`.
4. **Zustand store** — Could add a small chat slice for message state, or manage locally in ChatPanel.
5. **React Router** — Register `/chat` route in App.tsx, add to PANELS array.

---

## Dependencies

- **react-markdown** + **remark-gfm** — For assistant markdown rendering. Add via `pnpm add -S react-markdown remark-gfm`.
- Existing: React 19, Tailwind v4, shadcn/ui, zustand, TanStack Query.

---

## Implementation Notes

### lib/actionBlocks.ts (Utility)

```typescript
/**
 * Extract fenced ```action blocks from markdown.
 * Mirrors apps/server/src/claudeBridge.ts extractActionBlocks().
 */
export function extractActionBlocks(markdown: string): SuggestedAction[] {
  const out: SuggestedAction[] = [];
  const re = /```action\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    try {
      const json = JSON.parse(m[1].trim());
      out.push(json as SuggestedAction);
    } catch {
      // Skip malformed JSON
    }
  }
  return out;
}

/**
 * Remove action and question blocks from markdown for display.
 */
export function stripActionBlocks(markdown: string): string {
  return markdown.replace(/```action\s*\n[\s\S]*?\n```/g, "")
                 .replace(/```question\s*\n[\s\S]*?\n```/g, "");
}
```

### ChatPanel Structure

```tsx
// apps/web/src/panels/chat/ChatPanel.tsx
export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  // ... other state ...
  
  // Listen to WS chat events
  useEffect(() => {
    const onChatEvent = (event: ChatEvent) => {
      switch (event.type) {
        case "thinking":
          setLiveThinking(prev => prev + (event.text || ""));
          setIsThinking(true);
          break;
        case "text":
          // Append to last assistant message or create new
          break;
        case "done":
          setIsStreaming(false);
          // Stamp thinking onto message
          break;
        case "error":
          // Show error message
          break;
      }
    };
    // Subscribe to WS chat events (details in next section)
  }, []);
  
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {/* MessageList */}
      {/* ThinkingPane */}
      {/* ChatComposer */}
    </div>
  );
}
```

### lib/ws.ts Extensions

Extend `apps/web/src/lib/ws.ts` to handle chat frames:

```typescript
type ChatEventCallback = (event: ChatEvent) => void;
let chatListeners: ChatEventCallback[] = [];

export function sendChat(prompt: string): void {
  socket?.send(JSON.stringify({ type: "chat", prompt }));
}

export function onChatEvent(callback: ChatEventCallback): () => void {
  chatListeners.push(callback);
  return () => { chatListeners = chatListeners.filter(c => c !== callback); };
}

// In socket.onmessage:
socket.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "chat" && m.event) {
    chatListeners.forEach(cb => cb(m.event));
  } else if (m.type === "snapshot") {
    // ... existing cluster logic ...
  }
  // ...
};
```

---

## Test Examples (vitest)

```typescript
// tests/lib/actionBlocks.test.ts
import { extractActionBlocks, stripActionBlocks } from "@/lib/actionBlocks";
import { describe, it, expect } from "vitest";

describe("actionBlocks", () => {
  it("extracts single action block", () => {
    const md = `Here is what I recommend:\n\n\`\`\`action\n{"label":"Restart","kind":"restart","name":"web"}\n\`\`\``;
    const actions = extractActionBlocks(md);
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe("Restart");
  });
  
  it("skips malformed JSON", () => {
    const md = `\`\`\`action\n{invalid json}\n\`\`\``;
    const actions = extractActionBlocks(md);
    expect(actions).toHaveLength(0);
  });
  
  it("preserves non-action code fences", () => {
    const md = `\`\`\`bash\necho hello\n\`\`\`\n\n\`\`\`action\n{"label":"x","kind":"restart"}\n\`\`\``;
    const display = stripActionBlocks(md);
    expect(display).toContain("```bash");
    expect(display).not.toContain("```action");
  });
});
```
