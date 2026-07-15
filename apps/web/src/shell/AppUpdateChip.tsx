/**
 * Update pill in the GlobalHeader, driven by the desktop auto-updater state:
 *   available (auto)  → "Update to X"      → downloads in place
 *   available (link)  → "Update available" → opens the download page (unsigned macOS / dev)
 *   downloading       → "Downloading NN%"  → progress, no action
 *   downloaded        → "Restart to update" → quit + install + relaunch
 * Renders nothing when idle/checking or off-desktop.
 *
 * Inline styles + CSS custom properties to match GlobalHeader.tsx.
 */
import { Download, LoaderCircle, RotateCw } from "lucide-react";
import { useAppUpdate } from "./useAppUpdate";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as unknown as React.CSSProperties;

const OUTLINE: React.CSSProperties = {
  ...NO_DRAG,
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 26,
  paddingLeft: 11,
  paddingRight: 11,
  borderRadius: 20,
  background: "var(--accent-dim)",
  border: "1px solid color-mix(in oklab, var(--accent-primary) 36%, transparent)",
  cursor: "pointer",
  flexShrink: 0,
};

export function AppUpdateChip() {
  const { status, version, progress, canAutoInstall, download, install, open } = useAppUpdate();

  if (status === "downloaded") {
    return (
      <button
        onClick={install}
        title="Restart to finish updating Rigel"
        aria-label="Restart to update"
        style={{
          ...OUTLINE,
          background: "var(--accent-primary)",
          border: "1px solid var(--accent-primary)",
        }}
        className="hover:opacity-90 transition-opacity"
      >
        <RotateCw size={13} style={{ color: "var(--fg-inverse)" }} />
        <span className="text-xs" style={{ color: "var(--fg-inverse)", fontWeight: 700 }}>
          Restart to update
        </span>
      </button>
    );
  }

  if (status === "downloading") {
    return (
      <div
        title={`Downloading update… ${progress}%`}
        aria-label={`Downloading update, ${progress} percent`}
        style={{ ...OUTLINE, gap: 8, cursor: "default" }}
      >
        <LoaderCircle size={13} className="animate-spin" style={{ color: "var(--accent-primary)" }} />
        <span className="text-xs" style={{ color: "var(--accent-soft, #7dd3fc)", fontWeight: 600 }}>
          Downloading
        </span>
        <span
          style={{
            width: 46,
            height: 4,
            borderRadius: 2,
            background: "color-mix(in oklab, var(--accent-primary) 20%, transparent)",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              display: "block",
              width: `${Math.max(0, Math.min(100, progress))}%`,
              height: 4,
              borderRadius: 2,
              background: "var(--accent-primary)",
              transition: "width 0.2s ease",
            }}
          />
        </span>
        <span
          className="text-3xs"
          style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--accent-primary)" }}
        >
          {progress}%
        </span>
      </div>
    );
  }

  if (status === "available") {
    const auto = canAutoInstall;
    return (
      <button
        onClick={auto ? download : open}
        title={
          auto
            ? `Download and install Rigel ${version}`
            : `Rigel ${version} is available — open the download page`
        }
        aria-label={auto ? `Update to ${version}` : `Update available: ${version}`}
        style={OUTLINE}
        className="hover:opacity-90 transition-opacity"
      >
        <Download size={13} style={{ color: "var(--accent-primary)" }} />
        <span
          className="text-xs"
          style={{ color: "var(--accent-soft, #7dd3fc)", fontWeight: 600 }}
        >
          {auto ? "Update to" : "Update available"}
        </span>
        {version && (
          <span
            className="text-3xs"
            style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--accent-primary)" }}
          >
            {version}
          </span>
        )}
      </button>
    );
  }

  return null;
}
