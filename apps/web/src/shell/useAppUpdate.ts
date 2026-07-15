import { useCallback, useEffect, useState } from "react";
import { rigel, type UpdateState, type UpdateStatus } from "@/lib/desktop";

const IDLE: UpdateState = {
  status: "idle",
  version: null,
  progress: 0,
  canAutoInstall: false,
  error: null,
};

export interface UseAppUpdateResult {
  status: UpdateStatus;
  version: string | null;
  progress: number;
  canAutoInstall: boolean;
  /** Start downloading the update (real in-app update). */
  download(): void;
  /** Quit and install the downloaded update, then relaunch. */
  install(): void;
  /** Open the download page (fallback when in-app install isn't available). */
  open(): void;
}

/**
 * Subscribes to the desktop main's update state (pushed as the updater checks /
 * downloads / finishes). Reads the current state on mount, then live-updates.
 * Inert when there's no desktop bridge (web build) or an older bridge without
 * the update channel.
 */
export function useAppUpdate(): UseAppUpdateResult {
  const [state, setState] = useState<UpdateState>(IDLE);

  useEffect(() => {
    const bridge = rigel?.appUpdate;
    if (!bridge?.onState) return;
    let cancelled = false;
    bridge.getState().then((s) => {
      if (!cancelled) setState(s);
    }).catch(() => {});
    const off = bridge.onState((s) => setState(s));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const download = useCallback(() => void rigel?.appUpdate?.download(), []);
  const install = useCallback(() => void rigel?.appUpdate?.install(), []);
  const open = useCallback(() => void rigel?.appUpdate?.open(), []);

  return {
    status: state.status,
    version: state.version,
    progress: state.progress,
    canAutoInstall: state.canAutoInstall,
    download,
    install,
    open,
  };
}
