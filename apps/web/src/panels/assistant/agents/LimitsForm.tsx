// LimitsForm — the operational-limits grid. Controlled (value + onChange). Numbers
// emit numbers; monitor-namespaces is a comma/newline list emitted as string[].
import { useState, useEffect } from "react";
import type { AssistantLimits } from "@/lib/api";
import { inputClass } from "../components/primitives";

const NUM_FIELDS: { key: keyof AssistantLimits; label: string }[] = [
  { key: "pollIntervalMs", label: "Poll interval (ms)" },
  { key: "maxPerResourcePerHour", label: "Max per resource / hr" },
  { key: "maxPerNight", label: "Max per night" },
  { key: "maxAttemptsPerIncident", label: "Attempts per incident" },
  { key: "confirmPolls", label: "Confirm polls" },
];

/** Parse a comma/newline list into a trimmed, non-empty string[]. */
function parseNamespaces(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Serialize namespaces array for display (comma-space separated). */
function serializeNamespaces(ns: string[] | undefined): string {
  return (ns ?? []).join(", ");
}

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
  const [namespacesText, setNamespacesText] = useState<string>(serializeNamespaces(value.namespaces));

  // Keep local in sync when the parent pushes a new value from outside.
  useEffect(() => {
    setLocal(value);
    setNamespacesText(serializeNamespaces(value.namespaces));
  }, [value]);

  function handleNumChange(key: keyof AssistantLimits, raw: string) {
    const parsed = raw === "" ? undefined : Number(raw);
    const next = { ...local, [key]: parsed };
    setLocal(next);
    onChange(next);
  }

  function handleNamespacesChange(text: string) {
    setNamespacesText(text);
    const next = { ...local, namespaces: parseNamespaces(text) };
    setLocal(next);
    onChange(next);
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
      <label className="col-span-2 flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Monitor namespaces (blank = all)</span>
        <input
          type="text"
          aria-label="Monitor namespaces"
          disabled={disabled}
          value={namespacesText}
          onChange={(e) => handleNamespacesChange(e.target.value)}
          className={`w-full ${inputClass}`}
        />
      </label>
    </div>
  );
}
