import { useState } from "react";
import { Wrench, ChevronRight } from "lucide-react";
import type { ToolActivity } from "./types";
import { cn } from "@/lib/utils";

const STATUS_COLOR: Record<ToolActivity["status"], string> = {
  running: "var(--fg-secondary)",
  ok: "var(--status-running)",
  error: "var(--status-failed)",
};

export function ToolCard({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border bg-background/40 px-2.5 py-1.5 text-xs" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="flex items-center gap-2">
        <Wrench className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-mono font-medium text-foreground/90">{tool.name}</span>
        {tool.description && <span className="truncate text-muted-foreground">{tool.description}</span>}
        <span
          className="ml-auto inline-block size-2 shrink-0 rounded-full"
          style={{ background: STATUS_COLOR[tool.status] }}
          title={tool.status}
          aria-label={`tool ${tool.status}`}
        />
      </div>
      {tool.command && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-[#0C0D0F] px-2 py-1 font-mono text-[11px] text-foreground/90">
          <span className="select-none text-muted-foreground">$ </span>{tool.command}
        </pre>
      )}
      {tool.status === "error" && tool.output && (
        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">{tool.output}</pre>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {open ? "hide input" : "show input"}
      </button>
      {open && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">{tool.inputJSON}</pre>
      )}
    </div>
  );
}
