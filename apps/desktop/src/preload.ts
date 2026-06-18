// Minimal preload. The renderer is the UNCHANGED Helmsman SPA loaded from a real
// HTTP origin (http://127.0.0.1:<port>), and ALL of its transport is plain
// fetch(/api/*) + WebSocket(/ws) against that origin — so it needs nothing from
// Electron to function. We keep contextIsolation on and expose only a tiny,
// read-only `helmsman` bridge (app version) for diagnostics. No Node, no ipc,
// no fs — nothing that would widen the renderer's authority.
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("helmsman", {
  desktop: true,
  // Surfaced by the main process via an env var baked at preload-build time is
  // overkill; process.versions is available in the preload (Node) context.
  electronVersion: process.versions.electron,
});
