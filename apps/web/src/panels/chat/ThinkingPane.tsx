import { useEffect, useRef, useState } from "react";
import { Loader2, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { elapsedSeconds, thinkingVerb } from "./chatLogic";

interface Props {
  /** Live-accumulating thinking text for the in-progress turn. */
  liveThinking: string;
  /** Turn start instant, for the elapsed-seconds timer. */
  turnStartedAt: Date | null;
}

/**
 * ThinkingPane — shown only while streaming and thinking has arrived. Rotating
 * verb + spinner + elapsed seconds, with a collapsible reasoning body that
 * auto-scrolls to the tail and fades at the top.
 */
export function ThinkingPane({ liveThinking, turnStartedAt }: Props) {
  const [open, setOpen] = useState(false);
  const [verbIndex, setVerbIndex] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Rotate the verb every 2.5s.
  useEffect(() => {
    const id = setInterval(() => setVerbIndex((i) => i + 1), 2500);
    return () => clearInterval(id);
  }, []);

  // Tick the elapsed-seconds timer once a second.
  useEffect(() => {
    if (!turnStartedAt) return;
    setSeconds(elapsedSeconds(turnStartedAt));
    const id = setInterval(() => setSeconds(elapsedSeconds(turnStartedAt)), 1000);
    return () => clearInterval(id);
  }, [turnStartedAt]);

  // Auto-scroll the reasoning body to the tail on each delta.
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [liveThinking, open]);

  const hasThinking = liveThinking.trim().length > 0;

  return (
    <div className="border-t bg-muted/30 px-4 py-2">
      <button
        type="button"
        disabled={!hasThinking}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground disabled:cursor-default"
      >
        <Loader2 className="size-3.5 animate-spin" />
        <span className="font-medium text-foreground">{thinkingVerb(verbIndex)}</span>
        <span>{seconds}s</span>
        <span>· esc to interrupt</span>
        {hasThinking && (
          <ChevronRight
            className={cn("ml-auto size-3.5 transition-transform", open && "rotate-90")}
          />
        )}
      </button>
      {open && hasThinking && (
        <div
          ref={bodyRef}
          className="mt-2 max-h-[90px] overflow-auto text-xs italic text-muted-foreground/70 select-text [mask-image:linear-gradient(to_bottom,transparent,black_24px)]"
        >
          <pre className="whitespace-pre-wrap">{liveThinking}</pre>
        </div>
      )}
    </div>
  );
}
