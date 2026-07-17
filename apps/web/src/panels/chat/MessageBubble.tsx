import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkAlerts } from "@/lib/remarkAlerts";
import { User, Settings } from "lucide-react";
import {
  parseSuggestedActions,
  type SuggestedAction,
  type SuggestedQuestion,
  type SuggestedAlert,
} from "@/lib/actionBlocks";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ai-elements/reasoning";
import { SuggestedActionList } from "./SuggestedActionList";
import { SuggestedQuestionList } from "./SuggestedQuestionList";
import { SuggestedAlertList } from "./SuggestedAlertList";
import { ToolCard } from "./ToolCard";
import { RigelMark } from "@/components/RigelMark";
import type { ChatMessage } from "./types";
import { CodeBlock } from "./CodeBlock";
import { ChatBlockquote } from "./Callout";

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

/** Sender avatar: the Rigel mark for the assistant, a role glyph otherwise. */
function MessageAvatar({ role }: { role: ChatMessage["role"] }) {
  if (role === "assistant") {
    return (
      <Avatar
        size="sm"
        className="mt-0.5 ring-1 ring-[color-mix(in_srgb,var(--accent-primary)_30%,transparent)]"
      >
        <AvatarFallback className="bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] text-[var(--accent-primary)]">
          <RigelMark size={14} />
        </AvatarFallback>
      </Avatar>
    );
  }
  const Icon = role === "system" ? Settings : User;
  return (
    <Avatar size="sm" className="mt-0.5">
      <AvatarFallback className="bg-muted text-muted-foreground">
        <Icon className="size-3.5" />
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * MessageBubble — one chat turn. User/assistant turns are aligned bubbles with a
 * sender avatar; assistant text is parsed for action blocks (stripped from
 * display) and rendered as markdown. System turns (tool activity, errors) render
 * full-width without a bubble.
 */
export function MessageBubble({ message, onAction, onRunBatch, onAnswer, agentNamespace }: Props) {
  const isAssistant = message.role === "assistant";

  if (message.role === "system") {
    return (
      <div className="w-full min-w-0">
        {message.tool ? (
          <ToolCard tool={message.tool} />
        ) : message.text ? (
          <p className="whitespace-pre-wrap rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-2xs text-muted-foreground select-text">
            {message.text}
          </p>
        ) : null}
      </div>
    );
  }

  const { display, actions, questions, alerts } = isAssistant
    ? parseSuggestedActions(message.text)
    : {
        display: message.text,
        actions: [] as SuggestedAction[],
        questions: [] as SuggestedQuestion[],
        alerts: [] as SuggestedAlert[],
      };

  return (
    <Message from={message.role}>
      <MessageAvatar role={message.role} />
      <MessageContent>
        {isAssistant && message.thinking ? (
          <Reasoning duration={message.thinkingSeconds}>
            <ReasoningTrigger />
            <ReasoningContent>{message.thinking}</ReasoningContent>
          </Reasoning>
        ) : null}
        {isAssistant ? (
          <div className="chat-md select-text">
            <Markdown
              remarkPlugins={[remarkGfm, remarkAlerts]}
              components={{ pre: CodeBlock, blockquote: ChatBlockquote }}
            >
              {display}
            </Markdown>
          </div>
        ) : display ? (
          <p className="whitespace-pre-wrap text-xs text-foreground select-text">{display}</p>
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
      </MessageContent>
    </Message>
  );
}
