import { ArrowRight } from "lucide-react";
import type { SuggestedAction } from "@/lib/actionBlocks";
import { iconForKind } from "./actionIcons";

interface Props {
  actions: SuggestedAction[];
  onAction: (action: SuggestedAction) => void;
}

/**
 * SuggestedActionList — one button per parsed action, shown below an assistant
 * message. Tapping opens the ConfirmSheet (single-action flow; the "Run
 * selected" batch flow is deferred for MVP).
 *
 * Styled to match Swift's ActionRow: accent-coloured text/icon on a dim
 * translucent background with a faint accent border. Full-width, left-aligned,
 * stacked vertically — mirrors Swift's VStack layout.
 */
export function SuggestedActionList({ actions, onAction }: Props) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {actions.map((action, i) => {
        const Icon = iconForKind(action.kind);
        const destructive = action.destructive === true || action.kind === "purge";

        // Swift: foregroundStyle(Theme.Accent.primary) + background(Theme.Accent.primaryDim)
        // + strokeBorder(Theme.Accent.primary.opacity(0.4))
        // Destructive: foreground Theme.Status.failed (#EF4444), dim rgba(239,68,68,0.15)
        const color = destructive ? "#EF4444" : "#A855F7";
        const bgColor = destructive ? "rgba(239,68,68,0.15)" : "rgba(168,85,247,0.15)";
        const bgHover = destructive ? "rgba(239,68,68,0.22)" : "rgba(168,85,247,0.22)";
        const borderColor = destructive ? "rgba(239,68,68,0.4)" : "rgba(168,85,247,0.4)";

        return (
          <button
            key={`${action.kind}-${i}`}
            type="button"
            onClick={() => onAction(action)}
            style={{
              color,
              background: bgColor,
              border: `1px solid ${borderColor}`,
              borderRadius: "6px",
              padding: "7px 10px",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
              width: "100%",
              textAlign: "left",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              outline: "none",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = bgHover;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = bgColor;
            }}
            onFocus={(e) => {
              (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 0 0 2px ${borderColor}`;
            }}
            onBlur={(e) => {
              (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
            }}
          >
            <Icon size={12} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{action.label}</span>
            <ArrowRight size={10} style={{ opacity: 0.6, flexShrink: 0 }} />
          </button>
        );
      })}
    </div>
  );
}
