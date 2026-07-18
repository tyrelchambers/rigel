import type { CSSProperties, ReactNode } from "react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleInfo, faLightbulb, faCircleExclamation, faTriangleExclamation, faOctagonExclamation, faQuoteLeft } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";

type CalloutType = "note" | "tip" | "important" | "warning" | "caution" | "quote";

const META: Record<CalloutType, { color: string; Icon: IconDefinition; label: string | null }> = {
  note: { color: "var(--accent-primary)", Icon: faCircleInfo, label: "NOTE" },
  tip: { color: "var(--status-running)", Icon: faLightbulb, label: "TIP" },
  important: { color: "var(--accent-primary)", Icon: faCircleExclamation, label: "IMPORTANT" },
  warning: { color: "var(--status-pending)", Icon: faTriangleExclamation, label: "WARNING" },
  caution: { color: "var(--status-failed)", Icon: faOctagonExclamation, label: "CAUTION" },
  quote: { color: "var(--fg-tertiary)", Icon: faQuoteLeft, label: null },
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
          <FontAwesomeIcon icon={Icon} className="size-[13px]" />
          <span className="font-mono text-3xs font-semibold tracking-[1px] uppercase">{label}</span>
        </div>
      )}
      <div className={cn("chat-callout-body text-xs leading-[1.5]", isQuote && "flex items-start gap-1.5 text-[var(--fg-secondary)] italic")}>
        {isQuote && <FontAwesomeIcon icon={faQuoteLeft} className="mt-0.5 shrink-0 text-[color:var(--callout)] size-[14px]" />}
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
