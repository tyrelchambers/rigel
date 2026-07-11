import { useMemo, useState } from "react";
import { Check, ChevronsDownUp, Copy, Maximize2 } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { useCopyToClipboard } from "@/lib/useCopyToClipboard";
import { parseAnnotationValue } from "./annotationValue";
import { JsonHighlight } from "./jsonHighlight";

interface MetaChipsProps {
  title: string;
  entries?: Record<string, string> | null;
}

/**
 * A titled card of key/value chips for k8s labels or annotations. Plain
 * values render inline; JSON-shaped values (e.g.
 * `kubectl.kubernetes.io/last-applied-configuration`) show a clipped preview
 * that expands into syntax-highlighted, pretty-printed JSON. Renders nothing
 * when there are no entries.
 */
export function MetaChips({ title, entries }: MetaChipsProps) {
  const items = Object.entries(entries ?? {});
  const jsonKeys = items.filter(([, v]) => parseAnnotationValue(v ?? "").kind === "json").map(([k]) => k);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  if (items.length === 0) return null;

  const allExpanded = jsonKeys.length > 0 && jsonKeys.every((k) => expandedKeys.has(k));

  const toggleKey = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <SectionCard
      title={title}
      count={items.length}
      action={
        jsonKeys.length > 0 && (
          <button
            type="button"
            onClick={() => setExpandedKeys(allExpanded ? new Set() : new Set(jsonKeys))}
            className="inline-flex items-center gap-1 text-3xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronsDownUp className="size-3" />
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        )
      }
    >
      <div className="flex flex-col gap-[9px]">
        {items.map(([k, v]) => (
          <MetaChip
            key={k}
            entryKey={k}
            rawValue={v ?? ""}
            expanded={expandedKeys.has(k)}
            onToggle={() => toggleKey(k)}
          />
        ))}
      </div>
    </SectionCard>
  );
}

function MetaChip({
  entryKey,
  rawValue,
  expanded,
  onToggle,
}: {
  entryKey: string;
  rawValue: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const value = useMemo(() => parseAnnotationValue(rawValue), [rawValue]);
  const { copied, copy } = useCopyToClipboard();
  const isExpanded = value.kind === "json" && expanded;

  if (rawValue === "") {
    return (
      <div
        className="w-fit text-xs font-mono"
        style={{
          borderRadius: 6,
          border: "1px solid #26272B",
          overflow: "hidden",
          background: "#38BDF814",
          padding: "5px 13px",
          color: "#7DD3FC",
          fontWeight: 500,
        }}
      >
        {entryKey}
      </div>
    );
  }

  return (
    <div
      className="flex w-fit flex-col"
      style={{ borderRadius: 6, border: "1px solid #26272B", overflow: "hidden" }}
    >
      <div className="flex items-stretch" style={isExpanded ? { borderBottom: "1px solid #26272B" } : undefined}>
        <div
          className="text-xs font-mono flex items-center"
          style={{ background: "#38BDF814", padding: "5px 13px", color: "#7DD3FC", fontWeight: 500 }}
        >
          {entryKey}
        </div>
        <div
          className="flex flex-1 items-center gap-2"
          style={{ borderLeft: "1px solid #26272B", padding: "5px 13px" }}
        >
          {value.kind === "plain" ? (
            <span className="font-mono text-xs" style={{ color: "#FFFFFF", fontWeight: 600 }}>
              {value.text}
            </span>
          ) : (
            <>
              <span
                className="truncate font-mono text-xs"
                style={{ maxWidth: 340, overflow: "hidden", whiteSpace: "nowrap", color: "#A1A1AA" }}
              >
                {value.preview}
              </span>
              <button
                type="button"
                aria-label={isExpanded ? "Collapse" : "Expand"}
                onClick={onToggle}
                className="shrink-0"
              >
                <Maximize2 size={14} style={{ color: "#6B6B73" }} />
              </button>
            </>
          )}
          <button type="button" aria-label="Copy" onClick={() => copy(rawValue)} className="shrink-0">
            {copied ? <Check size={14} style={{ color: "#6B6B73" }} /> : <Copy size={14} style={{ color: "#6B6B73" }} />}
          </button>
        </div>
      </div>
      {isExpanded && value.kind === "json" && (
        <div style={{ background: "#121315", padding: "13px 16px" }}>
          <JsonHighlight data={value.data} />
        </div>
      )}
    </div>
  );
}
