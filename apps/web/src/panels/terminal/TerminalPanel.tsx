// Terminal — an interactive cluster shell (Rancher-style). xterm.js in the
// browser is wired over the shared /ws connection to a real PTY on the server
// (Bun native terminal). Keystrokes go up as term.input; PTY output comes back
// as term/data; the panel keeps the PTY sized to the viewport via term.resize.
// One PTY per connection: mounting starts it, leaving stops it.
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { Button } from "@/components/ui/button";
import { RotateCw } from "lucide-react";
import { onTermEvent, sendTermStart, sendTermInput, sendTermResize, sendTermStop } from "@/lib/ws";

export default function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  // Bump to restart the shell after it exits (re-runs the setup effect).
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "ui-monospace, 'Geist Mono', 'SFMono-Regular', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#0A0A0C",
        foreground: "#E4E4E7",
        cursor: "#7DD3FC",
        selectionBackground: "#264F78",
        black: "#1F1F24",
        brightBlack: "#52525B",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    setEnded(null);

    // Start the server PTY at the fitted size, then mirror keystrokes up.
    sendTermStart(term.cols, term.rows);
    const keyDisp = term.onData((d) => sendTermInput(d));

    // PTY output / lifecycle from the server.
    const offTerm = onTermEvent((msg) => {
      if (msg.event === "data" && msg.data != null) term.write(msg.data);
      else if (msg.event === "exit") setEnded(`Session ended${msg.code ? ` (exit ${msg.code})` : ""}.`);
      else if (msg.event === "error") setEnded(msg.message ?? "Terminal error.");
    });

    // Keep the PTY sized to the viewport.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendTermResize(term.cols, term.rows);
      } catch {
        /* element detached mid-resize */
      }
    });
    ro.observe(host);

    term.focus();

    return () => {
      offTerm();
      keyDisp.dispose();
      ro.disconnect();
      sendTermStop();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [generation]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PanelHeader title="Terminal" subtitle="Interactive cluster shell">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setGeneration((g) => g + 1)}>
          <RotateCw className="size-3.5" /> Restart
        </Button>
      </PanelHeader>

      <div style={{ position: "relative", flex: 1, minHeight: 0, background: "#0A0A0C" }}>
        <div ref={hostRef} style={{ position: "absolute", inset: 0, padding: "8px 10px" }} />
        {ended && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              background: "rgba(10,10,12,0.82)",
              backdropFilter: "blur(2px)",
            }}
          >
            <span style={{ fontSize: 13, color: "var(--fg-secondary)" }}>{ended}</span>
            <Button size="sm" className="gap-1.5" onClick={() => setGeneration((g) => g + 1)}>
              <RotateCw className="size-3.5" /> Restart shell
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
