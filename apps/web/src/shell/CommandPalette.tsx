/**
 * ⌘K Command Palette — mirrors CommandPalette.swift.
 * Single source of truth for panel entries: imports PANEL_META + NAV_GROUPS
 * from NavStrip (no duplication).
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { Search } from "lucide-react";
import { PANEL_META, NAV_GROUPS } from "./NavStrip";
import {
  filterEntries,
  wrapIndex,
  buildResourceEntries,
  type PaletteEntry,
} from "./commandPaletteLogic";
import { useCluster } from "@/store/cluster";

// Build the flat, ordered entry list from the nav groups — same order as sidebar.
function buildEntries(): PaletteEntry[] {
  const seen = new Set<string>();
  const entries: PaletteEntry[] = [];
  for (const group of NAV_GROUPS) {
    for (const key of group.panels) {
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = PANEL_META[key];
      if (!meta) continue;
      entries.push({
        id: key,
        title: meta.title,
        subtitle: meta.subtitle,
        route: meta.route,
        group: group.title ?? "Main",
      });
    }
  }
  return entries;
}

const PANEL_ENTRIES = buildEntries();

// ─── Palette modal ────────────────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const setFocusRequest = useCluster((s) => s.setFocusRequest);
  const [entries, setEntries] = useState<PaletteEntry[]>(PANEL_ENTRIES);

  const filtered = filterEntries(entries, query);

  // Reset state and rebuild the combined entry list each time it opens.
  useEffect(() => {
    if (open) {
      const resources = useCluster.getState().resources;
      setEntries([...PANEL_ENTRIES, ...buildResourceEntries(resources)]);
      setQuery("");
      setHighlightIdx(0);
      // Defer focus until the element is rendered.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Reset highlight to 0 when query changes.
  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

  // Scroll highlighted row into view.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-idx="${highlightIdx}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  const selectEntry = useCallback(
    (entry: PaletteEntry) => {
      onClose();
      navigate(entry.route);
      if (entry.kind && entry.focusKey) {
        setFocusRequest({ route: entry.route, kind: entry.kind, key: entry.focusKey });
      }
    },
    [navigate, onClose, setFocusRequest],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => wrapIndex(i + 1, filtered.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => wrapIndex(i - 1, filtered.length));
      return;
    }
    if (e.key === "Enter") {
      const entry = filtered[highlightIdx];
      if (entry) selectEntry(entry);
    }
  }

  if (!open) return null;

  return (
    // Backdrop
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(2px)",
      }}
      onMouseDown={(e) => {
        // Close on backdrop click (not on the inner panel).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Panel */}
      <div
        style={{
          width: 580,
          maxWidth: "calc(100vw - 2rem)",
          maxHeight: "60vh",
          background: "#141417",
          border: "1px solid #2a2a2e",
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        }}
      >
        {/* Input row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            borderBottom: "1px solid #2a2a2e",
          }}
        >
          <Search
            size={14}
            style={{ color: "#6B6B73", flexShrink: 0 }}
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search panels & resources…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#fff",
              fontSize: 14,
              fontFamily: "var(--font-geist, system-ui, sans-serif)",
            }}
          />
          <span
            style={{
              fontSize: 10,
              fontFamily: "monospace",
              color: "#6B6B73",
              background: "#0A0A0C",
              padding: "2px 5px",
              borderRadius: 4,
              letterSpacing: "0.04em",
            }}
          >
            ⌘K
          </span>
        </div>

        {/* Results list */}
        <div
          ref={listRef}
          role="listbox"
          style={{ overflowY: "auto", padding: "6px 6px" }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: 20,
                fontSize: 12,
                color: "#6B6B73",
                fontFamily: "monospace",
              }}
            >
              no matches
            </div>
          ) : (
            filtered.map((entry, idx) => {
              const isActive = idx === highlightIdx;
              const Icon = PANEL_META[entry.id]?.icon;
              return (
                <div
                  key={entry.id}
                  role="option"
                  aria-selected={isActive}
                  data-palette-idx={idx}
                  onClick={() => selectEntry(entry)}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    background: isActive ? "#A855F7" : "transparent",
                    transition: "background 80ms",
                  }}
                >
                  {Icon && (
                    <Icon
                      size={13}
                      style={{
                        flexShrink: 0,
                        width: 18,
                        color: isActive ? "#fff" : "#6B6B73",
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: isActive ? "#fff" : "#E4E4E7",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.title}
                    </div>
                    {entry.subtitle && (
                      <div
                        style={{
                          fontSize: 10,
                          fontFamily: "monospace",
                          color: isActive ? "rgba(255,255,255,0.65)" : "#6B6B73",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginTop: 1,
                        }}
                      >
                        {entry.subtitle}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: "monospace",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: isActive ? "rgba(255,255,255,0.6)" : "#4B4B55",
                    }}
                  >
                    {entry.group}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Hook: mount global ⌘K / Ctrl+K listener ─────────────────────────────────

/**
 * Mount a single global keydown listener for ⌘K / Ctrl+K. Returns
 * `[open, setOpen]` — mount ONCE at the app-shell level.
 */
export function useCommandPalette(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return [open, setOpen];
}
