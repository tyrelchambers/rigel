import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { type SuggestedAction, isDestructiveAction } from "@/lib/actionBlocks";
import { iconForKind } from "./actionIcons";

interface Props {
  actions: SuggestedAction[];
  /** Run a single action immediately (opens the ConfirmSheet). */
  onAction: (action: SuggestedAction) => void;
  /** Run the selected subset as a batch (opens the BatchConfirmSheet). */
  onRunBatch?: (actions: SuggestedAction[]) => void;
}

// purge (typed-name PurgeSheet), applyManifest (different endpoint), and
// proposeRepoFix (opens a PR, not a kubectl run) can't join a sequential batch,
// so they stay single-only.
const NON_BATCHABLE = new Set(["purge", "applyManifest", "proposeRepoFix"]);
const isBatchable = (a: SuggestedAction) => !NON_BATCHABLE.has(a.kind);

/**
 * SuggestedActionList — one button per parsed action, shown below an assistant
 * message (above any clarifying questions). Tapping a row runs that single action
 * via the ConfirmSheet. When a message has 2+ batchable actions, each batchable
 * row also gets a selection checkbox (all selected by default) and a batch bar
 * (None / All / Run selected (N)) runs the chosen subset through the
 * BatchConfirmSheet — parity with the Swift batch-action UI.
 */
export function SuggestedActionList({ actions, onAction, onRunBatch }: Props) {
  // Index-keyed deselection (web SuggestedAction has no id). Empty = all selected.
  const [deselected, setDeselected] = useState<Set<number>>(new Set());

  if (actions.length === 0) return null;

  const batchableIdx = actions.map((a, i) => (isBatchable(a) ? i : -1)).filter((i) => i >= 0);
  const showBatch = !!onRunBatch && batchableIdx.length >= 2;
  const selectedIdx = batchableIdx.filter((i) => !deselected.has(i));

  const toggle = (i: number) =>
    setDeselected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  const selectNone = () => setDeselected(new Set(batchableIdx));
  const selectAll = () => setDeselected(new Set());
  const runSelected = () => onRunBatch?.(selectedIdx.map((i) => actions[i]!));

  return (
    <div className="mt-1 flex flex-col gap-1">
      {actions.map((action, i) => {
        const Icon = iconForKind(action.kind);
        const destructive = isDestructiveAction(action);
        const color = destructive ? "var(--status-failed)" : "var(--accent-primary)";
        const bgColor = destructive ? "rgba(239,68,68,0.15)" : "var(--accent-dim)";
        const bgHover = destructive ? "rgba(239,68,68,0.22)" : "rgba(56, 189, 248,0.22)";
        const borderColor = destructive ? "rgba(239,68,68,0.4)" : "rgba(56, 189, 248,0.4)";
        const showCheckbox = showBatch && isBatchable(action);
        const selected = !deselected.has(i);

        return (
          <div key={`${action.kind}-${i}`} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {showCheckbox && (
              <button
                type="button"
                aria-label={selected ? "Deselect from batch" : "Select for batch"}
                aria-pressed={selected}
                onClick={() => toggle(i)}
                style={{
                  flexShrink: 0,
                  width: "16px",
                  height: "16px",
                  borderRadius: "4px",
                  border: `1px solid ${borderColor}`,
                  background: selected ? bgColor : "transparent",
                  color,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  outline: "none",
                }}
              >
                {selected && <Check size={11} strokeWidth={3} />}
              </button>
            )}
            <button
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
                flex: 1,
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
          </div>
        );
      })}

      {showBatch && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "2px" }}>
          <button
            type="button"
            onClick={selectAll}
            disabled={selectedIdx.length === batchableIdx.length}
            style={miniBtn(selectedIdx.length === batchableIdx.length)}
          >
            All
          </button>
          <button
            type="button"
            onClick={selectNone}
            disabled={selectedIdx.length === 0}
            style={miniBtn(selectedIdx.length === 0)}
          >
            None
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={runSelected}
            disabled={selectedIdx.length === 0}
            style={{
              color: "var(--accent-primary)",
              background: "var(--accent-dim)",
              border: "1px solid rgba(56, 189, 248,0.4)",
              borderRadius: "4px",
              padding: "5px 10px",
              fontSize: "12px",
              fontWeight: 600,
              cursor: selectedIdx.length === 0 ? "not-allowed" : "pointer",
              opacity: selectedIdx.length === 0 ? 0.4 : 1,
              outline: "none",
            }}
          >
            Run selected ({selectedIdx.length})
          </button>
        </div>
      )}
    </div>
  );
}

function miniBtn(disabled: boolean): React.CSSProperties {
  return {
    color: "var(--accent-primary)",
    background: "transparent",
    border: "1px solid rgba(56, 189, 248,0.4)",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "11px",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    outline: "none",
  };
}
