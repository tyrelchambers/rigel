# AI Chat Content Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render assistant message content as the polished typed-callout system from Pencil frame `JgClK` — colored alert callouts, gray quote callouts, code blocks with a language header, and styled lists — so a bare fenced block is never an anonymous "black box."

**Architecture:** A small remark plugin tags GitHub-style `[!TYPE]` alert blockquotes with a className. `react-markdown` component overrides render those (and plain blockquotes) through a new `Callout` component, and render fenced code through an enhanced `CodeBlock` with a language header. List styling lives in the existing `.chat-md` CSS block. Rigel's system prompt gains one instruction so it emits alert syntax. Nothing in the `packages/k8s` action-block parser changes.

**Tech Stack:** React 19, react-markdown v10, remark-gfm v4, lucide-react, Tailwind v4 + CSS design tokens, vitest (+ jsdom / @testing-library/react).

---

## Design tokens (use these exact CSS vars — no raw hex)

| Type | Color var | lucide icon | Label |
|------|-----------|-------------|-------|
| note | `--accent-primary` | `Info` | NOTE |
| tip | `--status-running` | `Lightbulb` | TIP |
| important | `--accent-primary` | `CircleAlert` | IMPORTANT |
| warning | `--status-pending` | `TriangleAlert` | WARNING |
| caution | `--status-failed` | `OctagonAlert` | CAUTION |
| quote | `--fg-tertiary` | `Quote` | (none) |

## File structure

- Create `apps/web/src/lib/remarkAlerts.ts` — remark transform: tag `[!TYPE]` blockquotes.
- Create `apps/web/src/lib/remarkAlerts.test.ts` — node-env unit tests.
- Create `apps/web/src/panels/chat/Callout.tsx` — `Callout` + `ChatBlockquote` renderers.
- Create `apps/web/src/panels/chat/Callout.test.tsx` — jsdom render tests.
- Modify `apps/web/src/panels/chat/CodeBlock.tsx` — add language header row.
- Create `apps/web/src/panels/chat/CodeBlock.test.tsx` — jsdom render tests.
- Modify `apps/web/src/panels/chat/MessageBubble.tsx:2-3,109` — wire plugin + overrides.
- Create `apps/web/src/panels/chat/MessageBubble.test.tsx` — jsdom integration test.
- Modify `apps/web/src/index.css:280-323` — code-block/blockquote/list CSS.
- Modify `apps/server/src/systemPrompt.ts:172` — add status-callout instruction.
- Create `apps/server/src/systemPrompt.test.ts` — assert instruction present.

---

## Task 1: `remarkAlerts` remark plugin

**Files:**
- Create: `apps/web/src/lib/remarkAlerts.ts`
- Test: `apps/web/src/lib/remarkAlerts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { remarkAlerts } from "./remarkAlerts";

/** Build a minimal mdast blockquote wrapping one paragraph with a leading text node. */
function bq(text: string) {
  return {
    type: "root",
    children: [
      {
        type: "blockquote",
        children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
      },
    ],
  } as any;
}

const firstBq = (tree: any) => tree.children[0];
const firstText = (tree: any) => firstBq(tree).children[0].children[0];

describe("remarkAlerts", () => {
  it("tags a [!WARNING] blockquote and strips the marker", () => {
    const tree = bq("[!WARNING]\nDisk almost full");
    remarkAlerts()(tree);
    expect(firstBq(tree).data.hProperties.className).toContain("markdown-alert-warning");
    expect(firstText(tree).value).toBe("Disk almost full");
  });

  it("lowercases the type and is case-insensitive", () => {
    const tree = bq("[!Tip]\nlooks good");
    remarkAlerts()(tree);
    expect(firstBq(tree).data.hProperties.className).toContain("markdown-alert-tip");
  });

  it("removes an empty leading text node when the alert has no inline body", () => {
    const tree = bq("[!NOTE]\n");
    remarkAlerts()(tree);
    expect(firstBq(tree).data.hProperties.className).toContain("markdown-alert-note");
    expect(firstBq(tree).children[0].children.length).toBe(0);
  });

  it("leaves a plain blockquote untouched", () => {
    const tree = bq("just a normal quote");
    remarkAlerts()(tree);
    expect(firstBq(tree).data).toBeUndefined();
    expect(firstText(tree).value).toBe("just a normal quote");
  });

  it("ignores an unknown alert type", () => {
    const tree = bq("[!BOGUS]\nx");
    remarkAlerts()(tree);
    expect(firstBq(tree).data).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/lib/remarkAlerts.test.ts`
Expected: FAIL — `Cannot find module './remarkAlerts'`.

- [ ] **Step 3: Write the plugin**

```ts
/**
 * remarkAlerts — tag GitHub-style `> [!TYPE]` blockquotes so the chat renderer
 * can draw them as typed callouts. Sets `data.hProperties.className` to
 * `markdown-alert markdown-alert-<type>` and strips the `[!TYPE]` marker from
 * the body. Plain blockquotes (no marker) are left as-is → gray quote callout.
 */
const ALERT = /^\s*\[!(note|tip|important|warning|caution)\]\s*(?:\n|$)/i;

export function remarkAlerts() {
  return (tree: unknown) => {
    walk(tree as Node);
  };
}

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
}

function walk(node: Node): void {
  if (!node || !Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (child.type === "blockquote") tagAlert(child);
    walk(child);
  }
}

function tagAlert(blockquote: Node): void {
  const paragraph = blockquote.children?.[0];
  if (!paragraph || paragraph.type !== "paragraph") return;
  const text = paragraph.children?.[0];
  if (!text || text.type !== "text" || typeof text.value !== "string") return;
  const match = ALERT.exec(text.value);
  if (!match) return;
  const type = match[1].toLowerCase();
  text.value = text.value.slice(match[0].length);
  if (text.value === "") paragraph.children!.shift();
  blockquote.data = blockquote.data ?? {};
  blockquote.data.hProperties = {
    ...(blockquote.data.hProperties ?? {}),
    className: `markdown-alert markdown-alert-${type}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test src/lib/remarkAlerts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/remarkAlerts.ts apps/web/src/lib/remarkAlerts.test.ts
git commit -m "feat(web): remark plugin to tag GitHub-style alert blockquotes"
```

---

## Task 2: `Callout` + `ChatBlockquote` components

**Files:**
- Create: `apps/web/src/panels/chat/Callout.tsx`
- Test: `apps/web/src/panels/chat/Callout.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatBlockquote } from "./Callout";

describe("ChatBlockquote", () => {
  it("renders a WARNING callout label for an alert className", () => {
    render(<ChatBlockquote className="markdown-alert markdown-alert-warning">Disk full</ChatBlockquote>);
    expect(screen.getByText("WARNING")).toBeInTheDocument();
    expect(screen.getByText("Disk full")).toBeInTheDocument();
  });

  it("renders a plain quote with no text label", () => {
    render(<ChatBlockquote>just a quote</ChatBlockquote>);
    expect(screen.getByText("just a quote")).toBeInTheDocument();
    expect(screen.queryByText("QUOTE")).not.toBeInTheDocument();
    expect(screen.queryByText("NOTE")).not.toBeInTheDocument();
  });

  it("maps caution to the CAUTION label", () => {
    render(<ChatBlockquote className="markdown-alert markdown-alert-caution">danger</ChatBlockquote>);
    expect(screen.getByText("CAUTION")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/panels/chat/Callout.test.tsx`
Expected: FAIL — `Cannot find module './Callout'`.

- [ ] **Step 3: Write the component**

```tsx
import type { ComponentType, ReactNode } from "react";
import { Info, Lightbulb, CircleAlert, TriangleAlert, OctagonAlert, Quote } from "lucide-react";
import { cn } from "@/lib/utils";

type CalloutType = "note" | "tip" | "important" | "warning" | "caution" | "quote";

const META: Record<CalloutType, { color: string; Icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>; label: string | null }> = {
  note: { color: "var(--accent-primary)", Icon: Info, label: "NOTE" },
  tip: { color: "var(--status-running)", Icon: Lightbulb, label: "TIP" },
  important: { color: "var(--accent-primary)", Icon: CircleAlert, label: "IMPORTANT" },
  warning: { color: "var(--status-pending)", Icon: TriangleAlert, label: "WARNING" },
  caution: { color: "var(--status-failed)", Icon: OctagonAlert, label: "CAUTION" },
  quote: { color: "var(--fg-tertiary)", Icon: Quote, label: null },
};

/** A typed content callout: left-accent bar, tinted fill, icon + mono label, body. */
export function Callout({ type, children }: { type: CalloutType; children?: ReactNode }) {
  const { color, Icon, label } = META[type];
  const isQuote = type === "quote";
  return (
    <div
      className={cn(
        "my-1.5 rounded-md border-l-[3px] py-2 pr-3 pl-3",
        "border-l-[color:var(--callout)] bg-[color-mix(in_srgb,var(--callout)_7%,transparent)]",
      )}
      style={{ "--callout": color } as React.CSSProperties}
    >
      {label && (
        <div className="mb-1 flex items-center gap-1.5 text-[color:var(--callout)]">
          <Icon size={13} strokeWidth={2.5} />
          <span className="font-mono text-3xs font-semibold tracking-[1px] uppercase">{label}</span>
        </div>
      )}
      <div className={cn("chat-callout-body text-xs leading-[1.5]", isQuote && "flex items-start gap-1.5 text-[var(--fg-secondary)] italic")}>
        {isQuote && <Quote size={14} className="mt-0.5 shrink-0 text-[color:var(--callout)]" />}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

/** react-markdown `blockquote` override: alert blockquotes → typed Callout, plain → quote. */
export function ChatBlockquote({ className, children }: { className?: string; children?: ReactNode }) {
  const match = /markdown-alert-(note|tip|important|warning|caution)/.exec(className ?? "");
  const type = (match?.[1] as CalloutType) ?? "quote";
  return <Callout type={type}>{children}</Callout>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test src/panels/chat/Callout.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/chat/Callout.tsx apps/web/src/panels/chat/Callout.test.tsx
git commit -m "feat(web): Callout + ChatBlockquote for typed chat callouts"
```

---

## Task 3: Code block language header

**Files:**
- Modify: `apps/web/src/panels/chat/CodeBlock.tsx`
- Test: `apps/web/src/panels/chat/CodeBlock.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodeBlock } from "./CodeBlock";

describe("CodeBlock", () => {
  it("shows the fenced language in the header", () => {
    render(<CodeBlock><code className="language-yaml">foo: bar</code></CodeBlock>);
    expect(screen.getByText("yaml")).toBeInTheDocument();
    expect(screen.getByText("foo: bar")).toBeInTheDocument();
  });

  it("falls back to 'text' when no language is set", () => {
    render(<CodeBlock><code>plain body</code></CodeBlock>);
    expect(screen.getByText("text")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/panels/chat/CodeBlock.test.tsx`
Expected: FAIL — no element with text "yaml".

- [ ] **Step 3: Rewrite `CodeBlock.tsx`**

```tsx
import { isValidElement, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/lib/useCopyToClipboard";
import { cn } from "@/lib/utils";

/** Recursively flatten a React node tree to its text content. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

/** Read the fenced language from the child `<code class="language-xxx">`. */
function codeLang(children: ReactNode): string {
  if (isValidElement(children)) {
    const className = (children.props as { className?: string }).className;
    const match = /language-([\w-]+)/.exec(className ?? "");
    if (match) return match[1];
  }
  return "text";
}

/** react-markdown `pre` override: a framed code block with a language header + Copy button. */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const { copied, copy } = useCopyToClipboard();
  const text = nodeText(children).replace(/\n$/, "");
  const lang = codeLang(children);
  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-[var(--border-subtle)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3 py-1">
        <span className="font-mono text-3xs tracking-[1px] text-[var(--fg-tertiary)] uppercase">{lang}</span>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={() => copy(text)}
          className={cn(
            "inline-flex cursor-pointer items-center gap-[5px] text-2xs leading-none",
            copied ? "text-[var(--status-running)]" : "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]",
          )}
        >
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test src/panels/chat/CodeBlock.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/chat/CodeBlock.tsx apps/web/src/panels/chat/CodeBlock.test.tsx
git commit -m "feat(web): language header on chat code blocks"
```

---

## Task 4: Wire the plugin + overrides into MessageBubble

**Files:**
- Modify: `apps/web/src/panels/chat/MessageBubble.tsx` (lines 2-3 imports, line 109 render)
- Test: `apps/web/src/panels/chat/MessageBubble.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "./types";

// ChatMessage = { id, role, text, thinking?, thinkingSeconds?, tool? } — id/role/text are the only required fields.
function assistant(text: string): ChatMessage {
  return { id: "1", role: "assistant", text };
}

describe("MessageBubble content blocks", () => {
  it("renders a [!WARNING] alert as a WARNING callout", () => {
    render(<MessageBubble message={assistant("> [!WARNING]\n> Disk almost full")} onAction={() => {}} />);
    expect(screen.getByText("WARNING")).toBeInTheDocument();
    expect(screen.getByText(/Disk almost full/)).toBeInTheDocument();
  });

  it("renders a fenced code block with its language header", () => {
    render(<MessageBubble message={assistant("```yaml\nfoo: bar\n```")} onAction={() => {}} />);
    expect(screen.getByText("yaml")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/panels/chat/MessageBubble.test.tsx`
Expected: FAIL — no "WARNING" element (blockquote still renders plain).

- [ ] **Step 3: Wire imports and render**

In `apps/web/src/panels/chat/MessageBubble.tsx`, change the imports at lines 2-3:

```tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkAlerts } from "@/lib/remarkAlerts";
```

Add to the existing local imports (near line 13):

```tsx
import { ChatBlockquote } from "./Callout";
```

Change the assistant markdown render (line 109) from:

```tsx
<Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>{display}</Markdown>
```

to:

```tsx
<Markdown remarkPlugins={[remarkGfm, remarkAlerts]} components={{ pre: CodeBlock, blockquote: ChatBlockquote }}>{display}</Markdown>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test src/panels/chat/MessageBubble.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/chat/MessageBubble.tsx apps/web/src/panels/chat/MessageBubble.test.tsx
git commit -m "feat(web): render alert callouts + code headers in chat messages"
```

---

## Task 5: Chat markdown CSS (code frame, remove old blockquote, styled lists)

**Files:**
- Modify: `apps/web/src/index.css:280-323`

No unit test (CSS). Verified via build + visual check in Task 7.

- [ ] **Step 1: Replace the code-block and blockquote rules**

Replace the `/* Code block */` block (`apps/web/src/index.css:302-323`, the `.chat-md pre`, `.chat-md pre code`, and `.chat-md blockquote` rules) with:

```css
/* Code block — framed by CodeBlock.tsx; the <pre> is just the sunken body. */
.chat-md pre {
    margin: 0;
    background: var(--surface-sunken);
    border: 0;
    border-radius: 0;
    padding: 10px;
    overflow-x: auto;
}
.chat-md pre code {
    font-size: 12px;
    background: transparent;
    color: var(--fg-primary);
    padding: 0;
    border-radius: 0;
}
/* blockquotes are rendered by Callout.tsx (ChatBlockquote) — no element styling here. */
```

- [ ] **Step 2: Replace the list rules with accent bullets + numbered badges**

Replace the existing `.chat-md ul`, `.chat-md ol`, `.chat-md li ...`, `.chat-md li`, and `.chat-md li::marker` rules (search upward from line 280 for the `ul`/`ol` rules and replace the whole list group) with:

```css
/* Lists — accent bullet dots (ul) and circular number badges (ol), hanging indent. */
.chat-md ul,
.chat-md ol {
    margin: 6px 0;
    padding: 0;
    list-style: none;
}
.chat-md ul > li,
.chat-md ol > li {
    position: relative;
    margin: 3px 0;
    padding-left: 22px;
}
.chat-md ul > li::before {
    content: "";
    position: absolute;
    left: 5px;
    top: 8px;
    width: 5px;
    height: 5px;
    border-radius: 999px;
    background: var(--accent-primary);
}
.chat-md ol {
    counter-reset: step;
}
.chat-md ol > li {
    counter-increment: step;
    padding-left: 28px;
}
.chat-md ol > li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 0;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--fg-secondary);
    font-size: 11px;
    font-family: var(--font-mono, ui-monospace);
    display: flex;
    align-items: center;
    justify-content: center;
}
.chat-md li ul,
.chat-md li ol {
    margin: 3px 0 0;
}
```

- [ ] **Step 3: Verify the build compiles the CSS**

Run: `pnpm --filter web build`
Expected: build succeeds (no CSS parse errors).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/index.css
git commit -m "feat(web): frame chat code blocks + accent bullets/number badges"
```

---

## Task 6: Teach Rigel to emit status callouts

**Files:**
- Modify: `apps/server/src/systemPrompt.ts` (append after line 172)
- Test: `apps/server/src/systemPrompt.test.ts`

The exported function is `systemPrompt(context: string | null, readContexts?: string[]): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { systemPrompt } from "./systemPrompt";

describe("systemPrompt status callouts", () => {
  it("instructs the model to use GitHub-style alert syntax", () => {
    const prompt = systemPrompt("prod");
    expect(prompt).toContain("[!WARNING]");
    expect(prompt).toContain("[!TIP]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test src/systemPrompt.test.ts`
Expected: FAIL — prompt does not contain `[!WARNING]`.

- [ ] **Step 3: Append the instruction**

In `apps/server/src/systemPrompt.ts`, immediately before the closing `` `; `` of the prompt template string (end of line 172), add:

```
\n\nUSE STATUS CALLOUTS. When a line of your answer is a status verdict, wrap it as a GitHub-style alert blockquote so the app renders it as a colored callout: \`> [!TIP]\` for a healthy/verified result, \`> [!WARNING]\` for something the user should watch, \`> [!CAUTION]\` for a dangerous or destructive condition, and \`> [!NOTE]\` / \`> [!IMPORTANT]\` for key context. One alert per verdict; keep the body to a sentence or two. Use a plain \`>\` blockquote (no marker) only when quoting text such as a log line or event message. Do not overuse callouts — most prose stays plain.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/server test src/systemPrompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/systemPrompt.ts apps/server/src/systemPrompt.test.ts
git commit -m "feat(server): instruct Rigel to emit status-callout alert syntax"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, test, build the web app**

Run: `pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build`
Expected: all pass.

- [ ] **Step 2: Test the server**

Run: `pnpm --filter @rigel/server test`
Expected: pass (including the new systemPrompt test).

- [ ] **Step 3: Visual check (only if the user asks to run the app)**

Per project convention, do NOT start a web dev server. If the user wants a live look, run `pnpm --filter desktop dev`, open the assistant chat, and confirm: an alert callout (colored bar + icon + label), a plain quote (gray bar + quote icon, italic), a fenced code block with a language header, and a numbered list with circular badges. Otherwise rely on Steps 1-2.

---

## Task 8: Docs + tickets (per user workflow)

**Files:** none (external — Outline + Plane)

- [ ] **Step 1:** Update the Rigel app doc in Outline: add a "Chat content blocks" section describing the callout system (alert syntax → colored callouts, quote callouts, code-block language headers, styled lists).
- [ ] **Step 2:** Create a Plane issue under the Rigel project recording this feature as shipped, linked to the Outline section.
