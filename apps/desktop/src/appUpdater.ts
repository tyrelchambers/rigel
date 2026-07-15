/**
 * In-app auto-update via electron-updater.
 *
 * Packaged Windows/Linux (and signed macOS) get the real flow: check → download
 * (delta when a .blockmap is present) → quitAndInstall. Because electron-updater
 * on macOS refuses to install an UNSIGNED build (Squirrel.Mac verifies the
 * Developer ID), any updater error — and dev, where there's no app-update.yml —
 * falls back to a plain version check that just surfaces "update available" and
 * links to the download page. So macOS stays usable until signing lands, then
 * the same chip upgrades to one-click updates with zero further changes.
 *
 * State is pushed to the renderer; the update chip renders whatever status it's in.
 */
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { checkForUpdate, DOWNLOAD_URL } from "./appUpdate";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** The version to move to (available / downloaded), else null. */
  version: string | null;
  /** Download progress 0–100 while `downloading`. */
  progress: number;
  /** True when electron-updater can install in place; false = download-page only. */
  canAutoInstall: boolean;
  error: string | null;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

let state: UpdateState = {
  status: "idle",
  version: null,
  progress: 0,
  canAutoInstall: false,
  error: null,
};
let broadcast: (s: UpdateState) => void = () => {};

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  broadcast(state);
}

export function getUpdateState(): UpdateState {
  return state;
}

/** Manual version check (GitHub API); populates a download-page-only "available". */
async function fallbackCheck(): Promise<void> {
  try {
    const info = await checkForUpdate(app.getVersion());
    if (info.updateAvailable) {
      set({ status: "available", version: info.latestVersion, canAutoInstall: false, error: null });
    } else {
      set({ status: "idle", version: null, canAutoInstall: false });
    }
  } catch {
    set({ status: "idle" });
  }
}

export function initAutoUpdater(opts: { send: (s: UpdateState) => void }): void {
  broadcast = opts.send;

  // No app-update.yml outside a packaged build → electron-updater can't run.
  // Use the manual check so the chip still works in dev / from source.
  if (!app.isPackaged) {
    void fallbackCheck();
    return;
  }

  autoUpdater.autoDownload = false; // the user clicks to download
  autoUpdater.autoInstallOnAppQuit = false; // we install via an explicit "Restart to update"

  autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info) =>
    set({ status: "available", version: info.version, canAutoInstall: true, error: null }),
  );
  autoUpdater.on("update-not-available", () => set({ status: "idle", version: null }));
  autoUpdater.on("download-progress", (p) =>
    set({ status: "downloading", progress: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    set({ status: "downloaded", version: info.version, progress: 100 }),
  );
  autoUpdater.on("error", () => {
    // Most commonly an unsigned macOS build. Degrade to the download-page path.
    void fallbackCheck();
  });

  void checkForUpdates();
  setInterval(() => void checkForUpdates(), SIX_HOURS);
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return void fallbackCheck();
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    await fallbackCheck();
  }
}

export async function downloadUpdate(): Promise<void> {
  try {
    set({ status: "downloading", progress: 0, error: null });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    await fallbackCheck();
  }
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export { DOWNLOAD_URL };
