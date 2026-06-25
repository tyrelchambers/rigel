// LimitsForm — the operational-limits grid. Controlled (value + onChange). Numbers
// emit numbers; monitor-namespaces is picked from the cluster's real namespace
// list via a multi-select dropdown (blank = all).
import { useState, useEffect } from "react";
import type { AssistantLimits } from "@/lib/api";
import { inputClass } from "../components/primitives";
import { NamespaceMultiSelect } from "./NamespaceMultiSelect";

const NUM_FIELDS: { key: keyof AssistantLimits; label: string }[] = [
  { key: "pollIntervalMs", label: "Poll interval (ms)" },
  { key: "maxPerResourcePerHour", label: "Max per resource / hr" },
  { key: "maxPerNight", label: "Max per night" },
  { key: "maxAttemptsPerIncident", label: "Attempts per incident" },
  { key: "confirmPolls", label: "Confirm polls" },
];

export function LimitsForm({
  value,
  onChange,
  disabled = false,
}: {
  value: AssistantLimits;
  onChange: (next: AssistantLimits) => void;
  disabled?: boolean;
}) {
  // Local state lets userEvent.clear + type work correctly in tests and
  // provides a snappy editing experience without waiting for parent re-renders.
  const [local, setLocal] = useState<AssistantLimits>(value);

  // Keep local in sync when the parent pushes a new value from outside.
  useEffect(() => setLocal(value), [value]);

  function patch(next: AssistantLimits) {
    setLocal(next);
    onChange(next);
  }

  function handleNumChange(key: keyof AssistantLimits, raw: string) {
    patch({ ...local, [key]: raw === "" ? undefined : Number(raw) });
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {NUM_FIELDS.map(({ key, label }) => (
        <label key={key} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <input
            type="number"
            aria-label={label}
            disabled={disabled}
            value={(local[key] as number | undefined) ?? ""}
            onChange={(e) => handleNumChange(key, e.target.value)}
            className={`w-full ${inputClass}`}
          />
        </label>
      ))}
      <div className="col-span-2 flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Monitor namespaces (blank = all)</span>
        <NamespaceMultiSelect
          value={local.namespaces ?? []}
          onChange={(namespaces) => patch({ ...local, namespaces })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
