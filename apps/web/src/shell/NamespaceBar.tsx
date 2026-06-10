/**
 * NamespaceBar — shared namespace selector at the top of the content column.
 * Mirrors NamespaceBar.swift: one shared per-context selection stored in the
 * Zustand cluster store (namespaceFilter). Panels already read that value.
 */
import { useState } from "react";
import { useLocation } from "react-router";
import { SquareDashed, ChevronDown, Check } from "lucide-react";
import { useCluster } from "@/store/cluster";

/**
 * Routes whose panels are namespace-scoped (mirrors PanelKind.isNamespaceScoped).
 * The bar is only shown when the active route is in this set.
 */
const NAMESPACE_SCOPED_ROUTES = new Set([
  "/deployments",
  "/pods",
  "/workloads",
  "/rightsizing",
  "/ingresses",
  "/services",
  "/secrets",
  "/configmaps",
  "/storage",
  "/rbac",
  "/events",
]);

export default function NamespaceBar() {
  const location = useLocation();
  // Strip trailing slashes / sub-paths for matching
  const basePath = "/" + (location.pathname.replace(/^\//, "").split("/")[0] ?? "");

  // Only render on namespace-scoped panels
  if (!NAMESPACE_SCOPED_ROUTES.has(basePath)) return null;

  return <NamespaceBarInner />;
}

function NamespaceBarInner() {
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const setNamespaceFilter = useCluster((s) => s.setNamespaceFilter);
  const resources = useCluster((s) => s.resources);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Extract namespace names from the store (kind "namespaces")
  const allNamespaces: string[] = Object.keys(resources["namespaces"] ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );

  const filtered = query
    ? allNamespaces.filter((ns) => ns.toLowerCase().includes(query.toLowerCase()))
    : allNamespaces;

  const currentLabel = namespaceFilter ?? "All namespaces";

  function handleSelect(value: string | null) {
    setNamespaceFilter(value);
    setOpen(false);
    setQuery("");
  }

  return (
    <div
      style={{
        background: "#141417",
        borderBottom: "1px solid #1A1A1A",
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
        position: "relative",
      }}
    >
      <SquareDashed size={11} style={{ color: "#6B6B73", flexShrink: 0 }} />
      <span style={{ fontSize: 11, color: "#6B6B73", fontWeight: 500 }}>Namespace</span>

      {/* Dropdown trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          background: "#050505",
          border: "1px solid #2A2A2A",
          borderRadius: 4,
          cursor: "pointer",
        }}
        title="Select namespace filter"
      >
        <span
          style={{
            fontFamily: "'Geist Variable', ui-monospace, monospace",
            fontSize: 12,
            fontWeight: 500,
            color: "#FFFFFF",
            whiteSpace: "nowrap",
            maxWidth: 200,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {currentLabel}
        </span>
        <ChevronDown size={9} style={{ color: "#6B6B73", flexShrink: 0 }} strokeWidth={2.5} />
      </button>

      {/* Dropdown popover */}
      {open && (
        <>
          {/* Click-away overlay */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 49 }}
            onClick={() => { setOpen(false); setQuery(""); }}
          />
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 16 + 11 + 8 + 8 + 65, // align under the trigger
              zIndex: 50,
              background: "#141417",
              border: "1px solid #2A2A2A",
              borderRadius: 6,
              width: 260,
              boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
              overflow: "hidden",
            }}
          >
            {/* Search field */}
            <div style={{ padding: "8px 10px", borderBottom: "1px solid #1A1A1A" }}>
              <input
                autoFocus
                placeholder="Filter namespaces…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "#FFFFFF",
                  fontSize: 12,
                  fontFamily: "'Geist Variable', sans-serif",
                }}
              />
            </div>

            {/* Options list */}
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {/* "All namespaces" row */}
              <NamespaceRow
                label="All namespaces"
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
                  style={{
                    padding: "8px 10px",
                    fontSize: 12,
                    color: "#6B6B73",
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
      className="hover:bg-[#1C1C22] transition-colors"
    >
      <Check
        size={10}
        strokeWidth={2.5}
        style={{ color: active ? "#A855F7" : "transparent", flexShrink: 0, width: 12 }}
      />
      <span
        style={{
          fontFamily: "'Geist Variable', ui-monospace, monospace",
          fontSize: 12,
          fontWeight: active ? 600 : 400,
          color: "#FFFFFF",
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
