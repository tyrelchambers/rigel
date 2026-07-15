import { useCallback, useEffect, useState } from "react";
import { rigel, type AppUpdateInfo } from "@/lib/desktop";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export interface UseAppUpdateResult {
  updateAvailable: boolean;
  latestVersion: string | null;
  /** Open the download page (desktop only; no-op in web-dev). */
  open(): void;
}

/**
 * Polls the desktop main for a newer published release (on mount, then every
 * six hours). Inert when there's no desktop bridge (web build) or the bridge
 * predates the appUpdate channel. Never throws.
 */
export function useAppUpdate(): UseAppUpdateResult {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);

  useEffect(() => {
    const bridge = rigel?.appUpdate;
    if (!bridge) return;
    let cancelled = false;
    const run = () => {
      bridge
        .check()
        .then((i) => {
          if (!cancelled) setInfo(i);
        })
        .catch(() => {});
    };
    run();
    const id = setInterval(run, SIX_HOURS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const open = useCallback(() => {
    void rigel?.appUpdate?.open();
  }, []);

  return {
    updateAvailable: info?.updateAvailable ?? false,
    latestVersion: info?.latestVersion ?? null,
    open,
  };
}
