/**
 * A pill in the GlobalHeader that appears only when a newer Rigel release is
 * published. Clicking it opens the download page (self-install waits on a signed
 * build + electron-updater). Renders nothing when up to date or off-desktop.
 *
 * Inline styles + CSS custom properties to match GlobalHeader.tsx.
 */
import { Download } from "lucide-react";
import { useAppUpdate } from "./useAppUpdate";

const NO_DRAG = {
  WebkitAppRegion: "no-drag",
} as unknown as React.CSSProperties;

export function AppUpdateChip() {
  const { updateAvailable, latestVersion, open } = useAppUpdate();
  if (!updateAvailable) return null;

  return (
    <button
      onClick={open}
      title={`Rigel ${latestVersion} is available — download the update`}
      aria-label={`Update available: Rigel ${latestVersion}`}
      style={{
        ...NO_DRAG,
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 20,
        background: "var(--accent-dim)",
        border: "1px solid color-mix(in oklab, var(--accent-primary) 36%, transparent)",
        cursor: "pointer",
        flexShrink: 0,
      }}
      className="hover:opacity-90 transition-opacity"
    >
      <Download size={13} style={{ color: "var(--accent-primary)", flexShrink: 0 }} />
      <span
        className="text-xs"
        style={{ color: "var(--accent-primary)", fontWeight: 600 }}
      >
        Update available
      </span>
      {latestVersion && (
        <span
          className="text-3xs"
          style={{
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--accent-primary)",
            opacity: 0.85,
          }}
        >
          {latestVersion}
        </span>
      )}
    </button>
  );
}
