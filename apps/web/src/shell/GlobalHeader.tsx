/**
 * GlobalHeader — a slim full-width bar across the top of every view.
 *
 * Left:  sidebar collapse toggle + the global NamespaceSelector.
 * Right: a search affordance that opens the existing ⌘K CommandPalette, and the
 *        account avatar.
 *
 * Inline styles + CSS custom properties to match App.tsx / NavStrip.tsx.
 */
import { PanelLeftClose, PanelLeftOpen, Search, User } from "lucide-react";
import { NamespaceSelector } from "./NamespaceBar";
import { RigelMark } from "@/components/RigelMark";

interface GlobalHeaderProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** Opens the existing CommandPalette (reuses App's setPaletteOpen). */
  onOpenSearch: () => void;
  /** Opens the Account modal. */
  onOpenAccount: () => void;
}

export function GlobalHeader({ sidebarCollapsed, onToggleSidebar, onOpenSearch, onOpenAccount }: GlobalHeaderProps) {
  return (
    <header
      style={{
        flexShrink: 0,
        height: 42,
        display: "flex",
        alignItems: "center",
        gap: 12,
        paddingLeft: 14,
        paddingRight: 14,
        background: "var(--surface-primary)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {/* Rigel brand mark */}
      <div
        style={{ display: "flex", alignItems: "center", flexShrink: 0, color: "var(--fg-primary)" }}
      >
        <RigelMark size={22} />
      </div>

      {/* Sidebar collapse toggle (icon-only ghost button) */}
      <button
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: 6,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          flexShrink: 0,
        }}
        className="hover:bg-[#1B1C1F] transition-colors"
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen size={16} style={{ color: "var(--fg-secondary)" }} />
        ) : (
          <PanelLeftClose size={16} style={{ color: "var(--fg-secondary)" }} />
        )}
      </button>

      <NamespaceSelector />

      {/* Spacer */}
      <div style={{ marginLeft: "auto" }} />

      {/* Global search — opens the existing ⌘K CommandPalette */}
      <button
        onClick={onOpenSearch}
        title="Search (⌘K)"
        aria-label="Search"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 28,
          paddingLeft: 10,
          paddingRight: 8,
          background: "var(--surface-sunken)",
          border: "1px solid #34353A",
          borderRadius: 6,
          cursor: "pointer",
        }}
        className="hover:opacity-90 transition-opacity"
      >
        <Search size={13} style={{ color: "var(--fg-tertiary)", flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: "var(--fg-tertiary)", fontWeight: 500 }}>Search…</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--fg-tertiary)",
            background: "var(--surface-elevated)",
            border: "1px solid #34353A",
            borderRadius: 4,
            padding: "1px 5px",
            lineHeight: "14px",
          }}
        >
          ⌘K
        </span>
      </button>

      {/* Account — user avatar opens the Account modal */}
      <button
        onClick={onOpenAccount}
        title="Account"
        aria-label="Account"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: "var(--accent-dim)",
          border: "1px solid var(--border-subtle)",
          cursor: "pointer",
          flexShrink: 0,
        }}
        className="hover:opacity-90 transition-opacity"
      >
        <User size={15} style={{ color: "var(--accent-primary)" }} />
      </button>
    </header>
  );
}
