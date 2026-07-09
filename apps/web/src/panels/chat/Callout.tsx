import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Info, Lightbulb, CircleAlert, TriangleAlert, OctagonAlert, Quote } from "lucide-react";
import { cn } from "@/lib/utils";

type CalloutType = "note" | "tip" | "important" | "warning" | "caution" | "quote";

const META: Record<CalloutType, { color: string; Icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>; label: string | null }> = {
  note: { color: "var(--accent-primary)", Icon: Info, label: "NOTE" },
  tip: { color: "var(--status-running)", Icon: Lightbulb, label: "TIP" },
  important: { color: "var(--accent-primary)", Icon: CircleAlert, label: "IMPORTANT" },
  warning: { color: "var(--status-pending)", Icon: TriangleAlert, label: "WARNING" },
  caution: { color: "var(--status-failed)", Icon: OctagonAlert, label: "CAUTION" },
  quote: { color: "var(--fg-tertiary)", Icon: Quote, label: null },
};

/** A typed content callout: left-accent bar, tinted fill, icon + mono label, body. */
export function Callout({ type, children }: { type: CalloutType; children?: ReactNode }) {
  const { color, Icon, label } = META[type];
  const isQuote = type === "quote";
  return (
    <div
      className={cn(
        "my-1.5 rounded-md border-l-[3px] py-2 pr-3 pl-3",
        "border-l-[color:var(--callout)] bg-[color-mix(in_srgb,var(--callout)_7%,transparent)]",
      )}
      style={{ "--callout": color } as CSSProperties}
    >
      {label && (
        <div className="mb-1 flex items-center gap-1.5 text-[color:var(--callout)]">
          <Icon size={13} strokeWidth={2.5} />
          <span className="font-mono text-3xs font-semibold tracking-[1px] uppercase">{label}</span>
        </div>
      )}
      <div className={cn("chat-callout-body text-xs leading-[1.5]", isQuote && "flex items-start gap-1.5 text-[var(--fg-secondary)] italic")}>
        {isQuote && <Quote size={14} className="mt-0.5 shrink-0 text-[color:var(--callout)]" />}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

/** react-markdown `blockquote` override: alert blockquotes → typed Callout, plain → quote. */
export function ChatBlockquote({ className, children }: { className?: string; children?: ReactNode }) {
  const match = /markdown-alert-(note|tip|important|warning|caution)/.exec(className ?? "");
  const type = (match?.[1] as CalloutType) ?? "quote";
  return <Callout type={type}>{children}</Callout>;
}
