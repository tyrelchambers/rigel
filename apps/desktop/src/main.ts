// Rigel desktop — Electron main process.
//
// Boots the Rigel Node server (apps/server) as a child of this Electron app,
// waits for it to report healthy, then loads a BrowserWindow at the local server
// URL. The renderer is the UNMODIFIED Rigel SPA: it talks to the server over
// relative /api/* (fetch) + /ws (WebSocket) using location.host, so pointing a
// window at http://127.0.0.1:<port> "just works" with zero web-app changes.
//
// Trust model: the server has no built-in auth. It's bound to loopback
// (HOST=127.0.0.1) and is only ever reachable by this desktop app on the same
// machine.
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, utilityProcess, type UtilityProcess } from "electron";
import { createServer } from "node:net";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { InstallStore } from "./installStore";
import { submitSignup, deliver } from "./signup";
import { decideRestart } from "./restartPolicy";

const SIGNUP_ENDPOINT = "https://api.rigel.run";
// Shared key for the signups endpoint — deliberately baked into the client
// (obfuscation, NOT real auth; the endpoint is a public signup). Must match the
// APP_KEY in the `rigel-signups` k8s Secret.
const SIGNUP_APP_KEY = "3f0be9f2807280c51284681d4424e3883dab9650c1ae081c";

// ── Layout ────────────────────────────────────────────────────────────────
// In dev, __dirname is apps/desktop/dist. The server source and built web SPA
// live in sibling apps under the monorepo root.
const DESKTOP_DIR = join(__dirname, ".."); // apps/desktop (dist/..)
const APPS_DIR = join(DESKTOP_DIR, ".."); // apps
// The server is re-bundled BY THE DESKTOP BUILD to dist/server.mjs (see build.mjs
// for why we can't fork apps/server's TS or its own ESM bundle under Electron's
// utility loader). We fork via server-entry.mjs (a thin parent-death watchdog
// wrapper that imports server.mjs) so the server self-terminates if the Electron
// main process is killed with SIGKILL. Both files live in dist/ next to main.js.
const SERVER_BUNDLE_DEV = join(__dirname, "server-entry.mjs");
const WEB_DIST_DEV = join(APPS_DIR, "web", "dist");
// The Rigel app icon. The packaged .app embeds build/icon.icns via
// electron-builder, but `electron .` (dev) shows the default Electron dock icon
// unless we set it ourselves — see boot().
const APP_ICON = join(DESKTOP_DIR, "build", "icon.png");

const SMOKE = process.env.HELMSMAN_SMOKE === "1";

let serverProc: UtilityProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let serverPort = 0;
// Set true once the user is intentionally quitting, so a server child killed as
// part of shutdown is NOT mistaken for a crash and respawned (see before-quit).
let quitting = false;
// Timestamps of recent unexpected server exits, for the crash-loop guard.
const serverCrashes: number[] = [];
// Settle delay before respawning a crashed server. The renderer's WebSocket
// reconnect (apps/web/src/lib/ws.ts) re-establishes once the new server binds.
const SERVER_RESTART_DELAY_MS = 800;

// ── Free-port helper ────────────────────────────────────────────────────────
// Ask the OS for an ephemeral port (listen(0)), read it, release it. There's a
// tiny TOCTOU window before the server rebinds it, but on loopback for a desktop
// app that's negligible and avoids a get-port dependency.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not resolve a free port")));
      }
    });
  });
}

// ── Stable window origin ──────────────────────────────────────────────────────
// The renderer loads http://127.0.0.1:<port>, and the browser partitions
// localStorage by origin (which includes the port). If we picked a fresh
// ephemeral port every launch the origin would change each time, wiping all
// persisted UI state (sidebar collapse, open nav groups, chat/terminal toggles).
// So we remember the last port and reuse it whenever it's still free; only when
// it's taken do we fall back to a new free port. Persisted in userData.
function portFile(): string {
  return join(app.getPath("userData"), "rigel-window.json");
}
function loadPreferredPort(): number | null {
  try {
    const { port } = JSON.parse(readFileSync(portFile(), "utf8")) as { port?: number };
    return typeof port === "number" && port > 0 ? port : null;
  } catch {
    return null;
  }
}
function savePreferredPort(port: number): void {
  try {
    writeFileSync(portFile(), JSON.stringify({ port }), { mode: 0o600 });
  } catch {
    // ignore quota / permission errors — we just lose origin stability
  }
}
/** True if `port` can be bound on loopback right now. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}
/** Reuse the last port if it's free (stable origin), else acquire a new one. */
async function resolveServerPort(): Promise<number> {
  const preferred = loadPreferredPort();
  if (preferred && (await portIsFree(preferred))) return preferred;
  return findFreePort();
}

// ── macOS PATH fix ──────────────────────────────────────────────────────────
// GUI-launched macOS apps inherit a minimal PATH (typically just /usr/bin:/bin:
// /usr/sbin:/sbin), so the forked server's child processes — kubectl, helm, git,
// claude, and the PTY's login shell — would ENOENT. `fix-path` resolves the real
// interactive login-shell PATH and writes it into process.env.PATH. We apply it
// on darwin (always — it's a robust no-op when the PATH is already complete, and
// it matters even in a packaged app's first launch).
function applyLoginPath(): void {
  if (process.platform !== "darwin") return;
  try {
    // fix-path is ESM-only; esbuild bundles it into this CJS file. It mutates
    // process.env.PATH in place.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fixPath = require("fix-path") as (() => void) | { default: () => void };
    (typeof fixPath === "function" ? fixPath : fixPath.default)();
  } catch (err) {
    console.warn("[rigel] fix-path failed (binaries may not resolve):", err);
  }
}

// ── Server fork ───────────────────────────────────────────────────────────
// We fork the desktop-bundled server.mjs via Electron's utilityProcess.fork.
//
// NOTE on why NOT tsx: the original plan was to fork apps/server/src/index.ts
// with execArgv ["--import","tsx"]. Electron PASSES execArgv through, but its
// utilityProcess ESM loader does NOT activate tsx's customization hooks, so the
// server's extensionless TS imports throw ERR_MODULE_NOT_FOUND. apps/server's
// own ESM bundle also fails under the utility loader ("Dynamic require of
// 'events' is not supported"). So build.mjs re-bundles the server to a desktop-
// owned dist/server.mjs (createRequire banner fixes the dynamic-require; node-pty
// stays external) — see build.mjs. This does NOT modify apps/server.
//
// PACKAGED (next task): point at the same server.mjs + node-pty + WEB_DIST copied
// under process.resourcesPath. Left compiling (not exercised) here; the packaging
// task wires the actual asar/resource layout.
function forkServer(port: number): UtilityProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1", // loopback-only; the server reads this (see server index.ts)
  };
  // Make sure the (possibly fixed) login PATH reaches the child explicitly.
  if (process.env.PATH) env.PATH = process.env.PATH;

  let entry: string;
  let cwd: string;

  if (app.isPackaged) {
    // ── PACKAGED branch ────────────────────────────────────────────────────
    // electron-builder copies (extraResources) the desktop server artifacts to
    // resources/server/ (server-entry.mjs + server.mjs + permissionHook.{ts,mjs})
    // with node-pty fully unpacked at resources/server/node_modules/node-pty, and
    // the built SPA to resources/web/dist. We fork server-entry.mjs (keeping the
    // parent-death watchdog) with cwd = resources/server so the server's
    // `import "node-pty"` resolves from resources/server/node_modules/node-pty
    // (an unpacked, executable native addon — never inside an asar).
    const serverDir = join(process.resourcesPath, "server");
    entry = join(serverDir, "server-entry.mjs");
    cwd = serverDir;
    env.WEB_DIST = join(process.resourcesPath, "web", "dist");

    // ── Permission-hook fix for the packaged app ───────────────────────────
    // A packaged GUI app has NO node/tsx on PATH, so the chat hook's default
    // command (`node --import tsx permissionHook.ts`) would silently fail and
    // mutation-gating would break. Instead, run the prebuilt .mjs hook via
    // Electron's OWN Node binary: ELECTRON_RUN_AS_NODE=1 makes the Electron
    // executable behave as plain Node, so the hook runs with zero external deps.
    //
    // CRUCIAL: we do NOT put ELECTRON_RUN_AS_NODE in the forked server's env —
    // utilityProcess.fork launches an Electron "Rigel Helper" with
    // `--type=utility`, and ELECTRON_RUN_AS_NODE=1 in its env makes that helper
    // refuse the flag ("bad option: --type=utility") and the server never starts.
    // Instead we INLINE the env var into the hook command string itself. claude
    // runs PreToolUse hook commands via a shell, so a leading `ELECTRON_RUN_AS_NODE=1`
    // assignment applies to JUST the hook subprocess — not the server, not kubectl/
    // helm/git/claude (which aren't Electron and would ignore it anyway). Paths are
    // single-quoted because a macOS .app path contains spaces.
    const hookMjs = join(serverDir, "permissionHook.mjs");
    const shq = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
    env.HELMSMAN_HOOK_CMD = `ELECTRON_RUN_AS_NODE=1 ${shq(process.execPath)} ${shq(hookMjs)}`;
  } else {
    // ── DEV branch ─────────────────────────────────────────────────────────
    // Fork the desktop-bundled server (dist/server.mjs). cwd = apps/desktop so
    // its `import "node-pty"` resolves from apps/desktop/node_modules/node-pty.
    entry = SERVER_BUNDLE_DEV;
    cwd = DESKTOP_DIR;
    env.WEB_DIST = WEB_DIST_DEV;
  }

  const child = utilityProcess.fork(entry, [], {
    env: env as Record<string, string>,
    cwd,
    stdio: "pipe",
  });

  // Surface the server's logs in the main process console so the dev sees the
  // "rigel server on :<port>" ready line, kubectl errors, etc.
  child.stdout?.on("data", (b: Buffer) => process.stdout.write(`[server] ${b}`));
  child.stderr?.on("data", (b: Buffer) => process.stderr.write(`[server] ${b}`));
  child.on("exit", (code) => {
    console.log(`[rigel] server exited (code=${code})`);
    serverProc = null;
    // Respawn only an UNEXPECTED death while a window is up. Intentional quit
    // (quitting), the headless smoke run, and the pre-window boot phase (the boot
    // health race owns that failure) are all left alone.
    if (quitting || SMOKE || mainWindow === null) return;
    scheduleServerRestart();
  });

  return child;
}

// Respawn the crashed server on the SAME port so the renderer's existing origin
// (and its WebSocket reconnect) keep working with no window reload. A crash loop
// is capped — past the limit we surface the failure instead of hot-looping.
function scheduleServerRestart(): void {
  const now = Date.now();
  serverCrashes.push(now);
  const decision = decideRestart(serverCrashes, now);
  if (!decision.restart) {
    console.error(`[rigel] giving up on the server: ${decision.reason}`);
    dialog.showErrorBox(
      "Rigel background server stopped",
      `The local server ${decision.reason}. Please quit and reopen Rigel.`,
    );
    return;
  }
  console.log(`[rigel] server crashed — restarting on :${serverPort} in ${SERVER_RESTART_DELAY_MS}ms`);
  setTimeout(() => {
    if (quitting || mainWindow === null) return;
    serverProc = forkServer(serverPort);
  }, SERVER_RESTART_DELAY_MS);
}

// ── Health gate ─────────────────────────────────────────────────────────────
// Poll GET /api/health until it returns 200 {ok:true}. Robust gate before we
// load the window (the stdout "ready" line is informational; health is truth).
async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body?.ok === true) return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server health timeout after ${timeoutMs}ms${lastErr ? `: ${String(lastErr)}` : ""}`);
}

// ── Window ───────────────────────────────────────────────────────────────
function createWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Rigel",
    show: !SMOKE, // headless smoke run keeps the window hidden
    backgroundColor: "#0b0f14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.js"),
    },
  });

  // External links (PR/GitHub target=_blank) → system browser; deny in-app
  // popups so the SPA stays a single trusted window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Null out the mainWindow reference when this window is destroyed so we don't
  // hold a stale BrowserWindow handle after it is closed.
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });

  // Open maximized (fill the screen) on load. Skipped for the headless smoke run.
  if (!SMOKE) win.maximize();

  void win.loadURL(`http://127.0.0.1:${port}`);
  return win;
}

// ── Boot ─────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  applyLoginPath();

  // Dev dock icon (macOS). The packaged .app embeds build/icon.icns, so this is
  // only needed in dev, where Electron otherwise shows its default icon.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const icon = nativeImage.createFromPath(APP_ICON);
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  // ── Signup IPC ──────────────────────────────────────────────────────────
  // Instantiate once per boot; userData is stable across the app's lifetime.
  const installStore = new InstallStore(app.getPath("userData"));
  // Background retry of any undelivered signup (offline on a previous run).
  void deliver(installStore, fetch, SIGNUP_ENDPOINT, SIGNUP_APP_KEY);

  ipcMain.handle("rigel:submit-signup", (_e, data: { name: string; email: string }) =>
    submitSignup(installStore, fetch, SIGNUP_ENDPOINT, SIGNUP_APP_KEY, data.name, data.email, app.getVersion(), process.platform),
  );
  ipcMain.handle("rigel:get-signup-data", () => installStore.profile);
  ipcMain.handle("rigel:open-chart-file", async () => {
    const res = await dialog.showOpenDialog({
      title: "Select a Helm chart (.tgz) or chart folder",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Helm chart", extensions: ["tgz", "gz"] }, { name: "All files", extensions: ["*"] }],
    });
    if (res.canceled || res.filePaths.length === 0) return { canceled: true };
    return { canceled: false, path: res.filePaths[0] };
  });

  serverPort = await resolveServerPort();
  savePreferredPort(serverPort); // remember it so the origin stays stable next launch
  console.log(`[rigel] starting server on 127.0.0.1:${serverPort}`);
  serverProc = forkServer(serverPort);

  // C1: race the health wait against the child's own exit so we fail fast if
  // the server crashes before becoming healthy (bad WEB_DIST, port conflict,
  // etc.) rather than polling a dead port for the full 15 s timeout.
  const exited = new Promise<never>((_, reject) => {
    serverProc!.once("exit", (code) =>
      reject(new Error(`server exited before healthy (code=${code})`))
    );
  });
  await Promise.race([waitForHealth(serverPort), exited]);

  console.log(`[rigel] server healthy on :${serverPort}`);

  mainWindow = createWindow(serverPort);

  if (SMOKE) {
    mainWindow.webContents.once("did-finish-load", () => {
      void runSmoke(serverPort).finally(() => app.quit());
    });
  }
}

// ── Headless smoke self-test ──────────────────────────────────────────────
// Verifies, without a visible UI: (1) the SPA loaded from the local server, and
// (2) node-pty works under Electron's bundled Node by driving a real PTY over
// the server's /ws and asserting echoed output round-trips.
async function runSmoke(port: number): Promise<void> {
  const loaded = mainWindow?.webContents.getURL() ?? "";
  const expected = `http://127.0.0.1:${port}`;
  const urlOk = loaded.startsWith(expected);
  console.log(`SMOKE: page loaded url=${loaded} (expected prefix ${expected}) → ${urlOk ? "PASS" : "FAIL"}`);

  try {
    await ptyUnderElectron(port);
    console.log("PTY_UNDER_ELECTRON: PASS");
  } catch (err) {
    console.log(`PTY_UNDER_ELECTRON: FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Open ws://127.0.0.1:<port>/ws, start a PTY, run `echo DESKTOP_PTY_OK`, and
// resolve when a {type:"term",event:"data"} frame contains the marker. Node 22
// (Electron 42's runtime) has a global WebSocket.
function ptyUnderElectron(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error("timed out waiting for DESKTOP_PTY_OK frame (10s)"));
    }, 10_000);

    const done = (err?: Error) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      err ? reject(err) : resolve();
    };

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "term.start", cols: 80, rows: 24 }));
      ws.send(JSON.stringify({ type: "term.input", data: "echo DESKTOP_PTY_OK\n" }));
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: { type?: string; event?: string; data?: string; message?: string };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "term" && msg.event === "error") {
        done(new Error(msg.message ?? "term error"));
        return;
      }
      if (msg.type === "term" && msg.event === "data" && typeof msg.data === "string" && msg.data.includes("DESKTOP_PTY_OK")) {
        done();
      }
    });
    ws.addEventListener("error", () => done(new Error("websocket error connecting to /ws")));
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(boot).catch((err: unknown) => {
  console.error("[rigel] failed to start:", err instanceof Error ? err.message : err);
  app.quit();
});

// C2: best-effort sync cleanup for catchable main-process exits (uncaught
// exceptions, normal exit). Does NOT cover SIGKILL of the Electron main —
// see the parent-death watchdog in dist/server-entry.mjs for that case.
process.on("exit", () => { try { serverProc?.kill(); } catch { /* noop */ } });

// macOS: stay in the dock when all windows close (do NOT quit).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS: recreate the window when the dock icon is clicked and none exist.
// M3: if the server has died (serverProc === null), re-boot instead of opening
// a window that points at a dead port.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length > 0) return;
  if (serverProc) {
    mainWindow = createWindow(serverPort);
  } else {
    void boot().catch((err: unknown) =>
      console.error("[rigel] re-boot failed:", err instanceof Error ? err.message : err)
    );
  }
});

// On quit, SIGTERM the server child and wait for it to actually exit before
// allowing the Electron process to terminate. This gives the server's SIGTERM
// hook time to run portForwards.stopAll() and reap its kubectl/PTY children.
// A 3 s timeout prevents a stuck child from hanging the quit indefinitely.
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true; // suppress any in-flight server-restart timer
  if (!serverProc) return; // nothing to drain; let the quit proceed
  event.preventDefault();
  const child = serverProc;
  const finish = () => { try { app.exit(0); } catch { /* noop */ } };
  const t = setTimeout(finish, 3000);
  child.once("exit", () => { clearTimeout(t); finish(); });
  try { child.kill(); } catch { clearTimeout(t); finish(); }
});
