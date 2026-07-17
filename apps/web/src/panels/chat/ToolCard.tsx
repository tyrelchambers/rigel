import { useState } from "react";
import { Wrench, ChevronDown, CircleDot, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ToolActivity } from "./types";
import { cn } from "@/lib/utils";

const STATUS: Record<
  ToolActivity["status"],
  { label: string; Icon: typeof CircleDot; className: string }
> = {
  running: { label: "Running", Icon: CircleDot, className: "animate-pulse text-muted-foreground" },
  ok: { label: "Done", Icon: CheckCircle2, className: "text-[var(--status-running)]" },
  error: { label: "Error", Icon: XCircle, className: "text-destructive" },
};

export function ToolCard({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[tool.status];
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="w-full rounded-md border border-border/60 bg-background/40 text-xs"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <Wrench className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-mono font-medium text-foreground/90">{tool.name}</span>
        {tool.description && (
          <span className="truncate text-muted-foreground">{tool.description}</span>
        )}
        <Badge variant="secondary" className="ml-auto gap-1 rounded-full font-normal">
          <status.Icon className={cn("size-3", status.className)} />
          {status.label}
        </Badge>
        <ChevronDown
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1.5 px-2.5 pb-2">
        {tool.command && (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-[#0C0D0F] px-2 py-1 font-mono text-2xs text-foreground/90">
            <span className="select-none text-muted-foreground">$ </span>
            {tool.command}
          </pre>
        )}
        {tool.output && (
          <pre
            className={cn(
              "whitespace-pre-wrap break-all rounded px-2 py-1 font-mono text-2xs",
              tool.status === "error"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
            )}
          >
            {tool.output}
          </pre>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
            Parameters
          </span>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-3xs text-muted-foreground">
            {tool.inputJSON}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
