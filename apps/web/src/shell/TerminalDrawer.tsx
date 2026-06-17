// TerminalDrawer — a Rancher-style interactive shell docked at the bottom of the
// content area. Mounted once at the app root and kept mounted (hidden via
// display:none when closed) so the PTY + scrollback survive navigation and
// toggling — that persistence is the whole reason it's a drawer, not a page.
//
// Single shell (v1): one PTY per connection, wired over /ws exactly like the old
// page. xterm is attached lazily on first open (it needs real dimensions), and
// the PTY is only torn down when the drawer unmounts (app close), never on hide.
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { SquareTerminal, RotateCw, X } from "lucide-react";
import { onTermEvent, sendTermStart, sendTermInput, sendTermResize, sendTermStop } from "@/lib/ws";

/** Window event that toggles the drawer — fired by the StatusBar chip, the nav
 *  item, and the command palette; App owns the open state and listens for it. */
export const TOGGLE_TERMINAL_EVENT = "helmsman:toggle-terminal";

const HEIGHT_KEY = "helmsman.terminal.height";
const MIN_HEIGHT = 140;

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v >= MIN_HEIGHT ? v : 320;
  } catch {
    return 320;
  }
}

export function TerminalDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const attachedRef = useRef(false); // xterm.open() done (needs a visible, sized host)
  const startedRef = useRef(false); // PTY spawned
  const [height, setHeight] = useState(readHeight);
  const [ended, setEnded] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0); // restart after exit

  // Create the xterm instance + wire I/O ONCE. The PTY is torn down only here
  // (drawer unmount = app close), so hiding the drawer keeps the session alive.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "ui-monospace, 'Geist Mono', 'SFMono-Regular', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0A0A0C", foreground: "#E4E4E7", cursor: "#7DD3FC", selectionBackground: "#264F78" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    const keyDisp = term.onData((d) => sendTermInput(d));
    const offTerm = onTermEvent((msg) => {
      if (msg.event === "data" && msg.data != null) term.write(msg.data);
      else if (msg.event === "exit") setEnded(`Session ended${msg.code ? ` (exit ${msg.code})` : ""}.`);
      else if (msg.event === "error") setEnded(msg.message ?? "Terminal error.");
    });

    return () => {
      offTerm();
      keyDisp.dispose();
      sendTermStop();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [generation]);

  // On (re)open: attach to the now-visible host, fit, and start the PTY the first
  // time; on later opens just re-fit and push the size to the PTY.
  useEffect(() => {
    if (!open) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    if (!attachedRef.current) {
      term.open(host);
      attachedRef.current = true;
    }
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
        if (!startedRef.current) {
          sendTermStart(term.cols, term.rows);
          startedRef.current = true;
        } else {
          sendTermResize(term.cols, term.rows);
        }
        term.focus();
      } catch {
        /* host detached */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, height, generation]);

  // Keep the PTY sized to the drawer while it's open (resize handle / window).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!open || !term || !fit) return;
      try {
        fit.fit();
        sendTermResize(term.cols, term.rows);
      } catch {
        /* mid-teardown */
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [open]);

  function restart() {
    startedRef.current = false;
    attachedRef.current = false;
    setEnded(null);
    setGeneration((g) => g + 1);
  }

  // Drag the top edge to resize; persist the chosen height.
  function onHandleDown(e: React.PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const max = Math.round(window.innerHeight * 0.8);
    function move(ev: PointerEvent) {
      const next = Math.min(Math.max(startH + (startY - ev.clientY), MIN_HEIGHT), max);
      setHeight(next);
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(height));
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Persist height whenever it settles (covers the pointerup race above).
  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      /* ignore */
    }
  }, [height]);

  return (
    <div
      style={{
        display: open ? "flex" : "none",
        flexDirection: "column",
        height,
        flexShrink: 0,
        borderTop: "1px solid #26272B",
        background: "#0A0A0C",
      }}
    >
      {/* Resize handle */}
      <div onPointerDown={onHandleDown} style={{ height: 6, cursor: "ns-resize", flexShrink: 0 }} aria-label="Resize terminal" />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: "1px solid #1F1F24", flexShrink: 0 }}>
        <SquareTerminal className="size-3.5" style={{ color: "var(--accent-primary)" }} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>Terminal</span>
        <span style={{ fontSize: 10, color: "var(--fg-tertiary)" }}>interactive cluster shell</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={restart} title="Restart shell" className="rounded p-1 hover:bg-white/5" aria-label="Restart shell">
            <RotateCw className="size-3.5" style={{ color: "var(--fg-tertiary)" }} />
          </button>
          <button onClick={onClose} title="Close (⌃`)" className="rounded p-1 hover:bg-white/5" aria-label="Close terminal">
            <X className="size-3.5" style={{ color: "var(--fg-tertiary)" }} />
          </button>
        </div>
      </div>

      {/* xterm host */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div ref={hostRef} style={{ position: "absolute", inset: 0, padding: "6px 10px" }} />
        {ended && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              background: "rgba(10,10,12,0.82)",
            }}
          >
            <span style={{ fontSize: 13, color: "var(--fg-secondary)" }}>{ended}</span>
            <button onClick={restart} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium" style={{ background: "var(--accent-primary)", color: "var(--fg-inverse)" }}>
              <RotateCw className="size-3.5" /> Restart shell
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
