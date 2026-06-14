import { ArrowRight } from "lucide-react";
import { type SuggestedAction, isDestructiveAction } from "@/lib/actionBlocks";
import { iconForKind } from "./actionIcons";

interface Props {
  actions: SuggestedAction[];
  onAction: (action: SuggestedAction) => void;
}

/**
 * SuggestedActionList — one button per parsed action, shown below an assistant
 * message (above any clarifying questions). Tapping opens the ConfirmSheet
 * (single-action flow; the "Run selected" batch flow is deferred for MVP).
 *
 * Pixel-for-pixel parity with Swift's ActionRow (MessageViews.swift):
 *   VStack spacing 4 · HStack spacing 6 · padding 10h/7v · Radius.sm (4) ·
 *   icon 11 semibold · label 12 semibold (multiline, leading) ·
 *   Spacer(min 4) · arrow 9 semibold opacity 0.6.
 *
 * Non-destructive: accent purple (#A855F7) text/icon on primaryDim
 * (rgba 168,85,247,0.15) with a 0.4 accent border. Destructive (delete/drain/
 * purge family, or the model's `destructive` hint): red (#EF4444) on
 * rgba(239,68,68,0.15) with a 0.4 red border. Hover darkens bg to 0.22; keyboard
 * focus shows a 2px box-shadow ring.
 */
export function SuggestedActionList({ actions, onAction }: Props) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {actions.map((action, i) => {
        const Icon = iconForKind(action.kind);
        const destructive = isDestructiveAction(action);

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
              borderRadius: "4px",
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
            <Icon size={11} strokeWidth={2.5} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{action.label}</span>
            <ArrowRight size={9} strokeWidth={2.5} style={{ opacity: 0.6, flexShrink: 0 }} />
          </button>
        );
      })}
    </div>
  );
}
