import { useState } from "react";
import { Bell, Check } from "lucide-react";
import { type SuggestedAlert } from "@/lib/actionBlocks";
import { useAssistantAction } from "@/lib/api";

interface Props {
  alerts: SuggestedAlert[];
  namespace: string;
}

const COLOR = "#A855F7";
const BG = "rgba(168,85,247,0.15)";
const BG_HOVER = "rgba(168,85,247,0.22)";
const BORDER = "rgba(168,85,247,0.4)";
const COLOR_SAVED = "#22C55E";
const BG_SAVED = "rgba(34,197,94,0.15)";
const BORDER_SAVED = "rgba(34,197,94,0.4)";

/**
 * SuggestedAlertList — renders ```alert blocks as "Create alert" buttons below
 * an assistant message. Tapping saves the rule via POST /api/assistant
 * (action "saveAlert"). Mirrors SuggestedActionList/SuggestedQuestionList styling
 * (purple accent, same border/padding/font). Shows a green check + "Saved: <label>"
 * after a successful save.
 */
export function SuggestedAlertList({ alerts, namespace }: Props) {
  const [savedIdx, setSavedIdx] = useState<Set<number>>(new Set());
  const [errorIdx, setErrorIdx] = useState<Record<number, string>>({});
  const action = useAssistantAction();

  if (alerts.length === 0) return null;

  function handleSave(alert: SuggestedAlert, i: number) {
    if (savedIdx.has(i) || action.isPending) return;
    setErrorIdx((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    action.mutate(
      { action: "saveAlert", namespace, alert },
      {
        onSuccess: () => setSavedIdx((prev) => new Set([...prev, i])),
        onError: (err) =>
          setErrorIdx((prev) => ({ ...prev, [i]: err.message })),
      },
    );
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      {alerts.map((alert, i) => {
        const saved = savedIdx.has(i);
        const err = errorIdx[i];
        const color = saved ? COLOR_SAVED : COLOR;
        const bg = saved ? BG_SAVED : BG;
        const bgHover = saved ? BG_SAVED : BG_HOVER;
        const border = saved ? BORDER_SAVED : BORDER;

        return (
          <div key={i}>
            <button
              type="button"
              disabled={saved || action.isPending}
              onClick={() => handleSave(alert, i)}
              style={{
                color,
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: "4px",
                padding: "7px 10px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: saved || action.isPending ? "default" : "pointer",
                width: "100%",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                outline: "none",
                transition: "background 0.15s",
                opacity: saved ? 1 : action.isPending ? 0.6 : 1,
              }}
              onMouseEnter={(e) => {
                if (!saved && !action.isPending)
                  (e.currentTarget as HTMLButtonElement).style.background = bgHover;
              }}
              onMouseLeave={(e) => {
                if (!saved && !action.isPending)
                  (e.currentTarget as HTMLButtonElement).style.background = bg;
              }}
              onFocus={(e) => {
                (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 0 0 2px ${border}`;
              }}
              onBlur={(e) => {
                (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
              }}
            >
              {saved ? (
                <Check size={11} strokeWidth={2.5} style={{ flexShrink: 0 }} />
              ) : (
                <Bell size={11} strokeWidth={2.5} style={{ flexShrink: 0 }} />
              )}
              <span style={{ flex: 1 }}>
                {saved ? `Saved: ${alert.label}` : alert.label}
              </span>
            </button>
            {err && (
              <p
                style={{
                  marginTop: "2px",
                  fontSize: "11px",
                  color: "#EF4444",
                  paddingLeft: "4px",
                }}
              >
                {err}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
