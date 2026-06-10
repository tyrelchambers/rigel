import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { User, Sparkles, Settings, ChevronRight } from "lucide-react";
import { parseSuggestedActions, type SuggestedAction } from "@/lib/actionBlocks";
import { cn } from "@/lib/utils";
import { SuggestedActionList } from "./SuggestedActionList";
import type { ChatMessage } from "./types";

interface Props {
  message: ChatMessage;
  onAction: (action: SuggestedAction) => void;
}

const ROLE_META = {
  user: { Icon: User, label: "You" },
  assistant: { Icon: Sparkles, label: "Helmsman" },
  system: { Icon: Settings, label: "System" },
} as const;

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
export function MessageBubble({ message, onAction }: Props) {
  const { Icon, label } = ROLE_META[message.role];
  const isAssistant = message.role === "assistant";
  const isSystem = message.role === "system";

  const { display, actions } = isAssistant
    ? parseSuggestedActions(message.text)
    : { display: message.text, actions: [] as SuggestedAction[] };

  return (
    <div className="flex gap-3 py-3">
      <div className="mt-0.5 shrink-0 text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[11px] font-medium uppercase tracking-[0.5px] text-muted-foreground">
          {label}
        </div>
        {isAssistant && message.thinking ? (
          <ThinkingTrail thinking={message.thinking} seconds={message.thinkingSeconds} />
        ) : null}
        {isAssistant ? (
          <div className="prose prose-sm max-w-none dark:prose-invert select-text [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_code]:text-xs">
            <Markdown remarkPlugins={[remarkGfm]}>{display}</Markdown>
          </div>
        ) : (
          <p
            className={cn(
              "whitespace-pre-wrap select-text",
              isSystem ? "text-xs text-muted-foreground" : "text-sm",
            )}
          >
            {display}
          </p>
        )}
        {isAssistant && <SuggestedActionList actions={actions} onAction={onAction} />}
      </div>
    </div>
  );
}
