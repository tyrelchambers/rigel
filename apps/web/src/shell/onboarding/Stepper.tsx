// Onboarding progress rail. State per step is derived from `current`, not
// hand-set: steps before it read "Complete" (green check), the current one
// "In progress" (accent, glowing number), later ones "Up next" (outlined).
// Connectors fill the gap between steps and turn green once passed.
import { Fragment } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck } from "@awesome.me/kit-6050953220/icons/classic/solid";

type StepState = "done" | "current" | "upcoming";

export function Stepper({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div style={rail}>
      {labels.map((label, i) => {
        const state: StepState = i < current ? "done" : i === current ? "current" : "upcoming";
        return (
          <Fragment key={label}>
            <Step index={i} label={label} state={state} />
            {i < labels.length - 1 && (
              <span
                style={{
                  flex: 1,
                  height: 2,
                  borderRadius: 2,
                  background: i < current ? "var(--status-running)" : "#FFFFFF14",
                }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function Step({ index, label, state }: { index: number; label: string; state: StepState }) {
  const statusText = state === "done" ? "Complete" : state === "current" ? "In progress" : "Up next";
  const statusColor =
    state === "done" ? "var(--status-running)" : state === "current" ? "var(--accent-primary)" : "var(--fg-tertiary)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, flexShrink: 0 }} aria-current={state === "current" ? "step" : undefined}>
      <span style={circle(state)}>
        {state === "done" ? (
          <FontAwesomeIcon icon={faCheck} className="size-[14px]" style={{ color: "var(--fg-inverse)" }} />
        ) : (
          <span
            className="text-2xs"
            style={{
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              color: state === "current" ? "var(--fg-inverse)" : "var(--fg-tertiary)",
            }}
          >
            {index + 1}
          </span>
        )}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          className="text-sm"
          style={{
            fontWeight: state === "upcoming" ? 500 : 600,
            color: state === "upcoming" ? "var(--fg-tertiary)" : "var(--fg-primary)",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <span className="text-2xs" style={{ fontWeight: 500, color: statusColor, whiteSpace: "nowrap" }}>
          {statusText}
        </span>
      </span>
    </div>
  );
}

const rail: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  width: "100%",
  padding: "20px 26px",
  background: "var(--surface-sunken)",
  borderTop: "1px solid var(--border-subtle)",
  borderBottom: "1px solid var(--border-subtle)",
};

function circle(state: StepState): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: 30,
    height: 30,
    borderRadius: 999,
    background:
      state === "done" ? "var(--status-running)" : state === "current" ? "var(--accent-primary)" : "transparent",
    border: state === "upcoming" ? "1.5px solid var(--border-strong)" : "none",
    boxShadow: state === "current" ? "0 0 14px color-mix(in oklab, var(--accent-primary) 40%, transparent)" : "none",
  };
}
