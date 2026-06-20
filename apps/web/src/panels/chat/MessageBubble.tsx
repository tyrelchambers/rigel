import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { User, Sparkles, Settings, ChevronRight } from "lucide-react";
import { parseSuggestedActions, type SuggestedAction, type SuggestedQuestion, type SuggestedAlert } from "@/lib/actionBlocks";
import { cn } from "@/lib/utils";
import { SuggestedActionList } from "./SuggestedActionList";
import { SuggestedQuestionList } from "./SuggestedQuestionList";
import { SuggestedAlertList } from "./SuggestedAlertList";
import { ToolCard } from "./ToolCard";
import { RigelMark } from "@/components/RigelMark";
import type { ChatMessage } from "./types";

interface Props {
  message: ChatMessage;
  onAction: (action: SuggestedAction) => void;
  /** Run the selected subset of actions as a batch. */
  onRunBatch?: (actions: SuggestedAction[]) => void;
  /** Send a picked clarifying-question option as the next message. */
  onAnswer?: (value: string) => void;
  /** Namespace used when saving a suggested alert rule. */
  agentNamespace?: string;
}

// Role color mirrors the Swift MessageBubble: user = pod-palette blue,
// assistant = accent purple, system = tertiary grey.
const ROLE_META = {
  user: { Icon: User, label: "You", color: "#60A5FA" },
  assistant: { Icon: Sparkles, label: "Rigel", color: "var(--accent-primary)" },
  system: { Icon: Settings, label: "System", color: "var(--fg-tertiary)" },
} as const;

/** Role-tinted card surface + border (assistant gets a faint purple wash). */
function cardSurface(role: ChatMessage["role"]): { background: string; borderColor: string } {
  if (role === "assistant") {
    return { background: "rgba(56, 189, 248, 0.06)", borderColor: "rgba(56, 189, 248, 0.2)" };
  }
  return { background: "var(--surface-sunken)", borderColor: "var(--border-subtle)" };
}

/** Collapsible "Thought for Ns" disclosure shown above an assistant message. */
function ThinkingTrail({ thinking, seconds }: { thinking: string; seconds?: number }) {
  const [open, setOpen] = useState(false);
  if (!thinking.trim()) return null;
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {seconds ? `Thought for ${seconds}s` : "Thought process"}
      </button>
      {open && (
        <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-muted px-3 py-2 text-xs whitespace-pre-wrap italic text-muted-foreground select-text">
          {thinking}
        </pre>
      )}
    </div>
  );
}

/**
 * MessageBubble — role-styled message. Assistant text is parsed for action
 * blocks (stripped from display) and rendered as markdown; user/system text is
 * plain.
 */
export function MessageBubble({ message, onAction, onRunBatch, onAnswer, agentNamespace }: Props) {
  const { Icon, label, color } = ROLE_META[message.role];
  const isAssistant = message.role === "assistant";
  const isSystem = message.role === "system";
  const surface = cardSurface(message.role);

  const { display, actions, questions, alerts } = isAssistant
    ? parseSuggestedActions(message.text)
    : { display: message.text, actions: [] as SuggestedAction[], questions: [] as SuggestedQuestion[], alerts: [] as SuggestedAlert[] };

  return (
    <div className="flex items-start gap-2">
      {/* Role avatar — colored circle. The assistant uses the Rigel mark. */}
      <div
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full"
        style={{ background: `${color}26`, color }}
        aria-hidden
      >
        {isAssistant ? <RigelMark size={13} /> : <Icon className="size-3" style={{ color }} />}
      </div>

      {/* Role-tinted bordered card */}
      <div
        className=" chat-bubble min-w-0 flex-1 rounded-md border px-2.5 py-2"
        style={surface}
      >
        <div
          className="mb-1 text-[10px] font-semibold uppercase tracking-[0.5px]"
          style={{ color }}
        >
          {label}
        </div>
        {isAssistant && message.thinking ? (
          <ThinkingTrail thinking={message.thinking} seconds={message.thinkingSeconds} />
        ) : null}
        {message.tool ? (
          <ToolCard tool={message.tool} />
        ) : isAssistant ? (
          <div className="chat-md select-text">
            <Markdown remarkPlugins={[remarkGfm]}>{display}</Markdown>
          </div>
        ) : display ? (
          <p
            className={cn(
              "whitespace-pre-wrap select-text",
              isSystem ? "text-xs text-muted-foreground" : "text-[13px] text-foreground",
            )}
          >
            {display}
          </p>
        ) : null}
        {isAssistant && (
          <SuggestedActionList actions={actions} onAction={onAction} onRunBatch={onRunBatch} />
        )}
        {isAssistant && onAnswer && (
          <SuggestedQuestionList questions={questions} onAnswer={onAnswer} />
        )}
        {isAssistant && (
          <SuggestedAlertList alerts={alerts} namespace={agentNamespace ?? "default"} />
        )}
      </div>
    </div>
  );
}
