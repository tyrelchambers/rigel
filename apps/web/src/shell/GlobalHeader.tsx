/**
 * GlobalHeader — a slim full-width bar across the top of every view.
 *
 * Left:  the global NamespaceSelector.
 * Right: a search affordance that opens the existing ⌘K CommandPalette, and the
 *        account avatar.
 *
 * Inline styles + CSS custom properties to match App.tsx.
 */
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft, faArrowRight, faMagnifyingGlass, faUser } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { NamespaceSelector } from "./NamespaceBar";
import { AppUpdateChip } from "./AppUpdateChip";
import { ToolIssues } from "./ToolIssues";
import { useNavHistory } from "./useNavHistory";
import { isMacDesktop, isWindowsDesktop } from "@/lib/desktop";
import { WINDOWS_CONTROLS_WIDTH } from "./WindowControls";
import { formatShortcut } from "@/lib/platform";

interface GlobalHeaderProps {
  /** Opens the existing CommandPalette (reuses App's setPaletteOpen). */
  onOpenSearch: () => void;
  /** Opens the Account modal. */
  onOpenAccount: () => void;
}

// Local use needs no account, so the header offers no sign-in affordance. The
// button below is kept, wired and tested behind this flag for the day it does.
const SHOW_ACCOUNT_BUTTON = false;

const DRAG = { WebkitAppRegion: "drag" } as unknown as React.CSSProperties;
const NO_DRAG = {
  WebkitAppRegion: "no-drag",
} as unknown as React.CSSProperties;

function NavArrowButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof faArrowLeft;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 6,
        background: "transparent",
        border: "1px solid transparent",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.35 : 1,
        color: "var(--fg-secondary)",
        flexShrink: 0,
      }}
      className={disabled ? "" : "hover:bg-[var(--surface-sunken)] transition-colors"}
    >
      <FontAwesomeIcon icon={icon} className="size-[14px]" />
    </button>
  );
}

export function GlobalHeader({
  onOpenSearch,
  onOpenAccount,
}: GlobalHeaderProps) {
  const { canGoBack, canGoForward, goBack, goForward } = useNavHistory();
  return (
    <header
      style={{
        ...DRAG,
        flexShrink: 0,
        height: 42,
        display: "flex",
        alignItems: "center",
        gap: 12,
        paddingLeft: isMacDesktop ? 102 : 14,
        paddingRight: isWindowsDesktop ? 0 : 14,
        background: "var(--surface-primary)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {/* History back / forward */}
      <div style={{ ...NO_DRAG, display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <NavArrowButton icon={faArrowLeft} label="Back" disabled={!canGoBack} onClick={goBack} />
        <NavArrowButton icon={faArrowRight} label="Forward" disabled={!canGoForward} onClick={goForward} />
      </div>

      <div style={{ ...NO_DRAG, display: "flex", minWidth: 0 }}>
        <NamespaceSelector />
      </div>

      {/* Spacer */}
      <div style={{ marginLeft: "auto" }} />

      {/* Update-available pill — shown only when a newer release exists */}
      <AppUpdateChip />

      {/* Missing kubectl/helm — shown only while a required binary is gone */}
      <ToolIssues style={NO_DRAG} />

      {/* Global search — opens the existing ⌘K CommandPalette */}
      <button
        onClick={onOpenSearch}
        title={`Search (${formatShortcut({ mod: true, key: "K" })})`}
        aria-label="Search"
        style={{
          ...NO_DRAG,
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
        <FontAwesomeIcon
          icon={faMagnifyingGlass}
          className="size-[13px]"
          style={{ color: "var(--fg-tertiary)", flexShrink: 0 }}
        />
        <span
          className="text-xs"
          style={{ color: "var(--fg-tertiary)", fontWeight: 500 }}
        >
          Search…
        </span>
        <span
          className="text-3xs"
          style={{
            fontWeight: 600,
            color: "var(--fg-tertiary)",
            background: "var(--surface-elevated)",
            border: "1px solid #34353A",
            borderRadius: 4,
            padding: "1px 5px",
            lineHeight: "14px",
          }}
        >
          {formatShortcut({ mod: true, key: "K" })}
        </span>
      </button>

      {SHOW_ACCOUNT_BUTTON && (
        <button
          onClick={onOpenAccount}
          title="Account"
          aria-label="Account"
          style={{
            ...NO_DRAG,
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
          <FontAwesomeIcon icon={faUser} className="size-[15px]" style={{ color: "var(--accent-primary)" }} />
        </button>
      )}

      {isWindowsDesktop && (
        <div style={{ ...NO_DRAG, width: WINDOWS_CONTROLS_WIDTH, height: "100%", flexShrink: 0 }} />
      )}
    </header>
  );
}
