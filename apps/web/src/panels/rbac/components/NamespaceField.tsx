import { useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";

interface Props {
  value: string;
  onChange: (namespace: string) => void;
  disabled?: boolean;
  className?: string;
}

/** Namespace dropdown fed by the namespaces watch. Owns its own subscription. */
export function NamespaceField({ value, onChange, disabled, className }: Props) {
  const resources = useCluster((s) => s.resources);
  useEffect(() => {
    subscribe("namespaces", "*");
    return () => unsubscribe("namespaces", "*");
  }, []);
  const namespaces = Object.keys(resources["namespaces"] ?? {}).sort((a, b) => a.localeCompare(b));
  const options = namespaces.length > 0 ? namespaces : value ? [value] : [];
  return (
    <div className={`relative ${disabled ? "pointer-events-none opacity-40" : ""} ${className ?? ""}`}>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] py-[9px] pl-[11px] pr-8 text-[12.5px] text-[var(--fg-primary)] outline-none"
      >
        {options.map((ns) => (
          <option key={ns} value={ns}>
            {ns}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-[14px] -translate-y-1/2 text-[var(--fg-tertiary)]" />
    </div>
  );
}
