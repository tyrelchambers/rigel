import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export type MessageRole = "user" | "assistant" | "system";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

/**
 * Message — one conversation turn. Aligns right for the user, left otherwise.
 * The `is-user` / `is-assistant` group class lets children (MessageContent)
 * react to the sender without prop-drilling.
 */
export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full items-start gap-2",
      from === "user" ? "is-user flex-row-reverse" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

/**
 * MessageContent — the turn body. The user turn is a filled bubble; the
 * assistant turn is a subtle surfaced card so replies read as solid, distinct
 * blocks.
 */
export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg px-3 py-2 text-sm",
      "group-[.is-user]:max-w-[85%] group-[.is-user]:bg-secondary group-[.is-user]:text-foreground",
      "group-[.is-assistant]:flex-1 group-[.is-assistant]:border group-[.is-assistant]:border-border/60 group-[.is-assistant]:bg-card/40 group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
