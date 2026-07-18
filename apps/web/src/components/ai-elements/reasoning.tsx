import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps, ReactNode } from "react";
import { Brain, ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoning() {
  const ctx = useContext(ReasoningContext);
  if (!ctx) throw new Error("Reasoning components must be used within <Reasoning>");
  return ctx;
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  defaultOpen?: boolean;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;

/**
 * Reasoning — collapsible "Thought for Ns" disclosure. Auto-opens while
 * streaming and auto-closes shortly after; otherwise starts collapsed.
 */
export function Reasoning({
  className,
  isStreaming = false,
  defaultOpen,
  duration,
  children,
  ...props
}: ReasoningProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? isStreaming);
  const wasStreamingRef = useRef(isStreaming);
  const autoClosedRef = useRef(false);

  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
      setIsOpen(true);
    } else if (wasStreamingRef.current && !autoClosedRef.current) {
      const id = setTimeout(() => {
        autoClosedRef.current = true;
        setIsOpen(false);
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(id);
    }
  }, [isStreaming]);

  const handleOpenChange = useCallback((open: boolean) => setIsOpen(open), []);
  const value = useMemo(
    () => ({ duration, isOpen, isStreaming, setIsOpen }),
    [duration, isOpen, isStreaming],
  );

  return (
    <ReasoningContext.Provider value={value}>
      <Collapsible
        className={cn("not-prose", className)}
        open={isOpen}
        onOpenChange={handleOpenChange}
        {...props}
      >
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
}

function thinkingMessage(isStreaming: boolean, duration?: number): ReactNode {
  if (isStreaming) return <Shimmer>Thinking…</Shimmer>;
  if (duration === undefined) return <span>Thought for a few seconds</span>;
  return <span>Thought for {duration}s</span>;
}

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

export function ReasoningTrigger({ className, children, ...props }: ReasoningTriggerProps) {
  const { isStreaming, isOpen, duration } = useReasoning();
  return (
    <CollapsibleTrigger
      className={cn(
        "flex items-center gap-1.5 text-2xs text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <Brain className="size-3" />
          {thinkingMessage(isStreaming, duration)}
          <ChevronDown className={cn("size-3 transition-transform", isOpen && "rotate-180")} />
        </>
      )}
    </CollapsibleTrigger>
  );
}

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent>;

export function ReasoningContent({ className, children, ...props }: ReasoningContentProps) {
  return (
    <CollapsibleContent className={cn("mt-1.5", className)} {...props}>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-2xs italic text-muted-foreground select-text">
        {children}
      </pre>
    </CollapsibleContent>
  );
}
