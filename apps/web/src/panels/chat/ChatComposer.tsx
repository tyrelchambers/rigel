import { useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onInterrupt: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
}

const PLACEHOLDER = "Ask Helmsman…  (/ for commands, @ to mention a resource)";
const LINE_HEIGHT = 20;
const MAX_LINES = 8;

/**
 * ChatComposer — multiline textarea (auto-grows to 8 lines) plus the send/stop
 * control. Enter sends; Shift+Enter inserts a newline; Escape interrupts a
 * stream. Slash/mention popovers are deferred (MVP).
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  onInterrupt,
  isStreaming,
  disabled,
  autoFocus,
  onFocusChange,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to MAX_LINES.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const max = LINE_HEIGHT * MAX_LINES;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      // No popover open (deferred) → interrupt if streaming, else ignore.
      if (isStreaming) {
        e.preventDefault();
        onInterrupt();
      }
      return;
    }
    if (e.key === "Enter") {
      if (e.shiftKey) return; // newline (default behavior)
      e.preventDefault();
      onSend();
    }
  }

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={PLACEHOLDER}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
          className={cn(
            "flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none",
            "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "disabled:opacity-50",
          )}
          style={{ lineHeight: `${LINE_HEIGHT}px`, maxHeight: LINE_HEIGHT * MAX_LINES }}
        />
        {isStreaming ? (
          <Button size="icon" variant="outline" onClick={onStop} aria-label="Stop">
            <Square />
          </Button>
        ) : (
          <Button size="icon" onClick={onSend} disabled={!canSend} aria-label="Send">
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  );
}
