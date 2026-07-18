/**
 * Namespace selector — one shared per-context selection stored in the Zustand
 * cluster store (namespaceFilter). Rendered once in the GlobalHeader so it's
 * available on every panel; panels that aren't namespace-scoped simply ignore
 * the filter.
 */
import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSquareDashed, faChevronDown, faCheck } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";

/**
 * The "Namespace [All namespaces ▾]" trigger + dropdown. Inline (no band/border
 * of its own) so PanelHeader can lay it out as the top row of the unified header.
 */
export function NamespaceSelector() {
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const setNamespaceFilter = useCluster((s) => s.setNamespaceFilter);
  const resources = useCluster((s) => s.resources);
  const accessMode = useCluster((s) => s.accessMode);
  const accessNamespaces = useCluster((s) => s.accessNamespaces);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // The selector owns the namespaces watch so the dropdown is populated wherever
  // it's shown (the per-resource panels don't subscribe "namespaces" themselves).
  useEffect(() => {
    if (accessMode !== "cluster-wide") return;
    subscribe("namespaces", "*");
    return () => unsubscribe("namespaces", "*");
  }, [accessMode]);

  const allNamespaces: string[] =
    accessMode === "scoped"
      ? [...accessNamespaces].sort((a, b) => a.localeCompare(b))
      : Object.keys(resources["namespaces"] ?? {}).sort((a, b) => a.localeCompare(b));

  const filtered = query
    ? allNamespaces.filter((ns) => ns.toLowerCase().includes(query.toLowerCase()))
    : allNamespaces;

  const allLabel = accessMode === "scoped" ? "Your namespaces" : "All namespaces";
  const currentLabel = namespaceFilter ?? allLabel;

  function handleSelect(value: string | null) {
    setNamespaceFilter(value);
    setOpen(false);
    setQuery("");
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <FontAwesomeIcon icon={faSquareDashed} className="size-[11px]" style={{ color: "var(--fg-tertiary)", flexShrink: 0 }} />
      <span className="text-2xs" style={{ color: "var(--fg-tertiary)", fontWeight: 500 }}>Namespace</span>

      {/* Trigger + popover (popover anchored to this relative wrapper) */}
      <div style={{ position: "relative" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            width: 180,
            background: "var(--surface-sunken)",
            border: "1px solid #34353A",
            borderRadius: 4,
            cursor: "pointer",
          }}
          title="Select namespace filter"
        >
          <span
            className="text-xs"
            style={{
              flexGrow: 1,
              minWidth: 0,
              textAlign: "left",
              fontFamily: "'Geist Variable', ui-monospace, monospace",
              fontWeight: 500,
              color: "var(--fg-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {currentLabel}
          </span>
          <FontAwesomeIcon icon={faChevronDown} className="size-[9px]" style={{ color: "var(--fg-tertiary)", flexShrink: 0 }} />
        </button>

        {open && (
          <>
            {/* Click-away overlay */}
            <div
              style={{ position: "fixed", inset: 0, zIndex: 49 }}
              onClick={() => {
                setOpen(false);
                setQuery("");
              }}
            />
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 4,
                zIndex: 50,
                background: "var(--surface-elevated)",
                border: "1px solid #34353A",
                borderRadius: 6,
                width: 260,
                boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
                overflow: "hidden",
              }}
            >
              {/* Search field */}
              <div style={{ padding: "8px 10px", borderBottom: "1px solid #26272B" }}>
                <input
                  autoFocus
                  placeholder="Filter namespaces…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="text-xs"
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--fg-primary)",
                    fontFamily: "'Manrope Variable', sans-serif",
                  }}
                />
              </div>

              {/* Options list */}
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <NamespaceRow
                  label={allLabel}
                  active={namespaceFilter === null}
                  onSelect={() => handleSelect(null)}
                />
                {filtered.map((ns) => (
                  <NamespaceRow
                    key={ns}
                    label={ns}
                    active={namespaceFilter === ns}
                    onSelect={() => handleSelect(ns)}
                  />
                ))}
                {filtered.length === 0 && allNamespaces.length > 0 && (
                  <div
                    className="text-xs"
                    style={{
                      padding: "8px 10px",
                      color: "var(--fg-tertiary)",
                      fontStyle: "italic",
                    }}
                  >
                    No matches
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface NamespaceRowProps {
  label: string;
  active: boolean;
  onSelect: () => void;
}

function NamespaceRow({ label, active, onSelect }: NamespaceRowProps) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        width: "100%",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
      className="hover:bg-[#1B1C1F] transition-colors"
    >
      <FontAwesomeIcon
        icon={faCheck}
        className="size-[10px]"
        style={{ color: active ? "var(--accent-primary)" : "transparent", flexShrink: 0, width: 12 }}
      />
      <span
        className="text-xs"
        style={{
          fontFamily: "'Geist Variable', ui-monospace, monospace",
          fontWeight: active ? 600 : 400,
          color: "var(--fg-primary)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>
    </button>
  );
}
