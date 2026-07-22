import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faWindowMinimize, faWindowMaximize, faWindowRestore, faXmark } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { isWindowsDesktop, rigel } from "@/lib/desktop";

const BTN_W = 30;
const BTN_H = 26;
const ICON = 11;

export const WINDOWS_CONTROLS_WIDTH = BTN_W * 3 + 12;

const NO_DRAG = { WebkitAppRegion: "no-drag" } as unknown as React.CSSProperties;

function ControlButton({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof faXmark;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: BTN_W,
        height: BTN_H,
        borderRadius: 6,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: "var(--fg-secondary)",
      }}
      className={danger ? "hover:bg-[#c42b1c] hover:text-white transition-colors" : "hover:bg-[var(--surface-elevated)] transition-colors"}
    >
      <FontAwesomeIcon icon={icon} style={{ fontSize: ICON }} />
    </button>
  );
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isWindowsDesktop) return;
    void rigel?.window?.isMaximized().then(setMaximized);
    return rigel?.window?.onMaximized(setMaximized);
  }, []);

  if (!isWindowsDesktop) return null;

  return (
    <div
      style={{
        ...NO_DRAG,
        position: "fixed",
        top: 0,
        right: 0,
        height: 42,
        display: "flex",
        alignItems: "center",
        gap: 0,
        paddingRight: 6,
        zIndex: 9999,
      }}
    >
      <ControlButton icon={faWindowMinimize} label="Minimize" onClick={() => void rigel?.window?.minimize()} />
      <ControlButton
        icon={maximized ? faWindowRestore : faWindowMaximize}
        label={maximized ? "Restore" : "Maximize"}
        onClick={() => void rigel?.window?.toggleMaximize()}
      />
      <ControlButton icon={faXmark} label="Close" danger onClick={() => void rigel?.window?.close()} />
    </div>
  );
}
