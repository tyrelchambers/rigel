/**
 * Nav launcher — a floating grid popover anchored above the launcher button in
 * the cluster rail. Opens with ⌘/ (Ctrl+/) or the button. Search auto-focuses on
 * open; ↑/↓/←/→ move a selection across the grid, Enter opens it, Esc closes.
 * Lives alongside the ⌘K command palette (this is the browsable visual surface).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Search, Star } from "lucide-react";
import { PANEL_META, NAV_GROUPS } from "./navModel";
import {
  buildLauncherGroups,
  buildFavoritesCells,
  flattenVisible,
  nextIndex,
  type LauncherCell,
} from "./navLauncherLogic";
import { loadFavorites, saveFavorites, toggleFavorite } from "./navFavorites";

const COLS = 3;

interface NavLauncherProps {
  open: boolean;
  onClose: () => void;
}

export function NavLauncher({ open, onClose }: NavLauncherProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [selected, setSelected] = useState(0);

  const favoritesCells = useMemo(() => buildFavoritesCells(favorites, PANEL_META), [favorites]);
  const groups = useMemo(() => buildLauncherGroups(NAV_GROUPS, PANEL_META), []);
  const visible = useMemo(
    () => flattenVisible(favoritesCells, groups, query),
    [favoritesCells, groups, query],
  );

  // Reset + autofocus each time the launcher opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Typing resets the selection to the first visible cell (the top match).
  useEffect(() => setSelected(0), [query]);

  const openCell = useCallback(
    (cell: LauncherCell) => {
      onClose();
      navigate(cell.route);
    },
    [navigate, onClose],
  );

  const toggleFav = useCallback((key: string) => {
    setFavorites((prev) => {
      const next = toggleFavorite(prev, key);
      saveFavorites(next);
      return next;
    });
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter") {
      const cell = visible[selected];
      if (cell) openCell(cell);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => nextIndex(i, e.key as "ArrowLeft", COLS, visible.length));
    }
  }

  if (!open) return null;

  // Index of a cell within the flat `visible` list, for highlight + focus.
  const visIndex = (key: string) => visible.findIndex((c) => c.key === key);

  const renderCell = (cell: LauncherCell) => {
    const idx = visIndex(cell.key);
    const isSelected = idx === selected;
    const Icon = PANEL_META[cell.key]?.icon;
    const fav = favorites.includes(cell.key);
    return (
      <div
        key={cell.key + "@" + idx}
        role="option"
        aria-selected={isSelected}
        onClick={() => openCell(cell)}
        onMouseEnter={() => setSelected(idx)}
        className="group flex items-center justify-between gap-2.5 rounded-md px-2.5 py-2 cursor-pointer border transition-colors"
        style={{
          background: isSelected ? "var(--accent-primary-dim, rgba(56,189,248,0.15))" : "var(--surface-primary)",
          borderColor: isSelected ? "var(--accent-primary)" : "var(--border-subtle)",
        }}
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <span
            className="flex items-center justify-center rounded-sm shrink-0"
            style={{ width: 26, height: 26, background: "var(--surface-sunken)" }}
          >
            {Icon && <Icon size={15} style={{ color: "var(--fg-secondary)" }} />}
          </span>
          <span
            className="text-xs truncate"
            style={{ color: "var(--fg-primary)", fontWeight: 500 }}
          >
            {cell.title}
          </span>
        </span>
        <button
          type="button"
          aria-label={fav ? `Unfavorite ${cell.title}` : `Favorite ${cell.title}`}
          onClick={(e) => { e.stopPropagation(); toggleFav(cell.key); }}
          className="shrink-0 p-0.5"
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            opacity: fav ? 1 : 0,
          }}
        >
          <Star
            size={14}
            style={{
              color: fav ? "var(--accent-primary)" : "var(--fg-tertiary)",
              fill: fav ? "var(--accent-primary)" : "transparent",
            }}
            className={fav ? "" : "group-hover:!opacity-100"}
          />
        </button>
      </div>
    );
  };

  const gridStyle = { display: "grid", gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`, gap: 10 } as const;
  const sectionLabel = (label: string) => (
    <div
      className="text-3xs font-semibold uppercase"
      style={{ color: "var(--fg-tertiary)", letterSpacing: "0.06em", padding: "0 2px" }}
    >
      {label}
    </div>
  );

  return (
    // Transparent light-dismiss backdrop.
    <div
      style={{ position: "fixed", inset: 0, zIndex: 998 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Popover anchored above the launcher button (rail is 56px wide). */}
      <div
        role="dialog"
        aria-label="Navigation launcher"
        onKeyDown={handleKeyDown}
        style={{
          position: "fixed",
          left: 64,
          bottom: 52,
          width: 700,
          maxWidth: "calc(100vw - 80px)",
          maxHeight: "calc(100vh - 120px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 52px rgba(0,0,0,0.65)",
        }}
      >
        {/* Search header */}
        <div
          className="flex items-center gap-2.5"
          style={{ padding: "14px 14px 12px", borderBottom: "1px solid var(--border-subtle)" }}
        >
          <span
            className="flex items-center gap-2.5 flex-1 rounded-md"
            style={{ padding: "10px 12px", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)" }}
          >
            <Search size={16} style={{ color: "var(--fg-tertiary)", flexShrink: 0 }} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search resources…"
              className="text-xs flex-1"
              style={{ background: "transparent", border: "none", outline: "none", color: "var(--fg-primary)" }}
            />
            <span
              className="text-3xs"
              style={{ fontFamily: "monospace", color: "var(--fg-tertiary)", background: "#ffffff0f", padding: "2px 6px", borderRadius: 4 }}
            >
              Esc
            </span>
          </span>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: "auto", padding: "14px 14px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
          {favoritesCells.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="flex items-center gap-1.5">
                {sectionLabel("Favorites")}
                <Star size={11} style={{ color: "var(--accent-primary)", fill: "var(--accent-primary)" }} />
              </span>
              <div style={gridStyle}>
                {favoritesCells.filter((c) => visIndex(c.key) >= 0).map(renderCell)}
              </div>
            </section>
          )}

          {groups.map((g) => {
            const cells = g.cells.filter((c) => visIndex(c.key) >= 0);
            if (cells.length === 0) return null;
            return (
              <section key={g.title} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sectionLabel(g.title)}
                <div style={gridStyle}>{cells.map(renderCell)}</div>
              </section>
            );
          })}

          {visible.length === 0 && (
            <div className="text-xs" style={{ textAlign: "center", padding: 20, color: "var(--fg-tertiary)", fontFamily: "monospace" }}>
              no matches
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Mount a single global keydown listener for ⌘/ (Ctrl+/). Returns
 * `[open, setOpen]` — mount ONCE at the app-shell level.
 */
export function useNavLauncher(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "/") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return [open, setOpen];
}
