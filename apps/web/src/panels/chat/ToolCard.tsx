import { useState } from "react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faWrench,
  faChevronDown,
  faCircleDot,
  faCircleCheck,
  faCircleXmark,
  faServer,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ToolActivity } from "./types";
import { parseCommandTarget } from "./toolTarget";
import { cn } from "@/lib/utils";

const STATUS: Record<
  ToolActivity["status"],
  { label: string; icon: IconDefinition; className: string }
> = {
  running: { label: "Running", icon: faCircleDot, className: "animate-pulse text-muted-foreground" },
  ok: { label: "Done", icon: faCircleCheck, className: "text-[var(--status-running)]" },
  error: { label: "Error", icon: faCircleXmark, className: "text-destructive" },
};

export function ToolCard({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[tool.status];
  const target = parseCommandTarget(tool.command);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="w-full rounded-md border border-border/60 bg-background/40 text-xs"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <FontAwesomeIcon icon={faWrench} className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-mono font-medium text-foreground/90">{tool.name}</span>
        {tool.description && (
          <span className="truncate text-muted-foreground">{tool.description}</span>
        )}
        {target.context && (
          <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-2xs text-muted-foreground">
            <FontAwesomeIcon icon={faServer} className="size-2.5" aria-hidden />
            {target.namespace ? `${target.context} · ${target.namespace}` : target.context}
          </span>
        )}
        <Badge
          variant="secondary"
          className={cn("gap-1 rounded-full font-normal", !target.context && "ml-auto")}
        >
          <FontAwesomeIcon icon={status.icon} className={cn("size-3", status.className)} />
          {status.label}
        </Badge>
        <FontAwesomeIcon
          icon={faChevronDown}
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
