import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faStar } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useCommand } from "@/lib/shortcuts/useCommand";
import { PANEL_META, NAV_GROUPS } from "./navModel";
import {
  buildLauncherGroups,
  buildFavoritesCells,
  flattenVisible,
  matchesQuery,
  moveSelection,
  type ArrowKey,
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

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => setSelected(0), [query]);

  const favVisible = favoritesCells.filter((c) => matchesQuery(c.title, query));
  const groupSections = groups
    .map((g) => ({ title: g.title, cells: g.cells.filter((c) => matchesQuery(c.title, query)) }))
    .filter((s) => s.cells.length > 0);
  const sectionSizes = [
    ...(favVisible.length > 0 ? [favVisible.length] : []),
    ...groupSections.map((s) => s.cells.length),
  ];

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
      setSelected((i) => moveSelection(i, e.key as ArrowKey, sectionSizes, COLS));
    }
  }

  if (!open) return null;

  const renderCell = (cell: LauncherCell, idx: number) => {
    const isSelected = idx === selected;
    const Icon = PANEL_META[cell.key]?.icon;
    const fav = favorites.includes(cell.key);
    const starVisible = fav || isSelected;
    return (
      <div
        key={cell.key + "@" + idx}
        role="option"
        aria-selected={isSelected}
        onClick={() => openCell(cell)}
        onMouseEnter={() => setSelected(idx)}
        className="group flex items-center justify-between gap-2.5 rounded-md px-2.5 py-2 cursor-pointer border transition-colors"
        style={{
          background: isSelected ? "var(--accent-dim)" : "var(--surface-primary)",
          borderColor: isSelected ? "var(--accent-primary)" : "var(--border-subtle)",
        }}
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <span
            className="flex items-center justify-center rounded-sm shrink-0"
            style={{ width: 26, height: 26, background: "var(--surface-sunken)" }}
          >
            {Icon &&
              (typeof Icon === "function" ? (
                <Icon size={15} style={{ color: "var(--fg-secondary)" }} />
              ) : (
                <FontAwesomeIcon icon={Icon} className="size-[15px]" style={{ color: "var(--fg-secondary)" }} />
              ))}
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
          className={`shrink-0 p-0.5 transition-opacity ${starVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{ background: "transparent", border: "none", cursor: "pointer" }}
        >
          <FontAwesomeIcon
            icon={faStar}
            className="size-[14px]"
            style={{
              color: fav ? "var(--accent-primary)" : "var(--fg-tertiary)",
            }}
          />
        </button>
      </div>
    );
  };

  const gridStyle = { display: "grid", gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`, gap: 10 } as const;
  const sectionLabel = (label: string, trailing?: React.ReactNode) => (
    <div className="flex items-center gap-2" style={{ padding: "0 2px" }}>
      <span
        className="text-3xs font-semibold uppercase shrink-0"
        style={{ color: "var(--fg-primary)", letterSpacing: "0.06em" }}
      >
        {label}
      </span>
      {trailing}
      <span className="flex-1" style={{ height: 1, background: "var(--border-strong)" }} />
    </div>
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 998 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
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
          height: 616,
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
        <div
          className="flex items-center gap-2.5"
          style={{ padding: "14px 14px 12px", borderBottom: "1px solid var(--border-subtle)" }}
        >
          <span
            className="flex items-center gap-2.5 flex-1 rounded-md"
            style={{ padding: "10px 12px", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)" }}
          >
            <FontAwesomeIcon icon={faMagnifyingGlass} className="size-[16px]" style={{ color: "var(--fg-tertiary)", flexShrink: 0 }} />
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
              style={{ fontFamily: "monospace", color: "var(--fg-tertiary)", background: "var(--surface-elevated)", padding: "2px 6px", borderRadius: 4 }}
            >
              Esc
            </span>
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
          {favVisible.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sectionLabel(
                "Favorites",
                <FontAwesomeIcon icon={faStar} className="size-[11px] shrink-0" style={{ color: "var(--accent-primary)" }} />,
              )}
              <div style={gridStyle} role="listbox" aria-label="Favorites">
                {favVisible.map((c, i) => renderCell(c, i))}
              </div>
            </section>
          )}

          {groupSections.map((s, si) => {
            const base =
              favVisible.length +
              groupSections.slice(0, si).reduce((n, x) => n + x.cells.length, 0);
            return (
              <section key={s.title} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sectionLabel(s.title)}
                <div style={gridStyle} role="listbox" aria-label={s.title}>
                  {s.cells.map((c, i) => renderCell(c, base + i))}
                </div>
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

export function useNavLauncher(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useCommand("nav.launcher", () => setOpen((prev) => !prev));
  return [open, setOpen];
}
