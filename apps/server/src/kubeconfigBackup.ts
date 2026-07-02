import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { format } from "date-fns";

/** The backup path for a kubeconfig: `<path>.rigel-backup-<stamp>`, same dir. */
export function backupKubeconfigPath(kubeconfigPath: string, stamp: string): string {
  return `${kubeconfigPath}.rigel-backup-${stamp}`;
}

/** A compact filesystem-local timestamp like 20260621-101500. */
export function backupStamp(now: Date): string {
  return format(now, "yyyyMMdd-HHmmss");
}

interface FsLike {
  existsSync: (p: string) => boolean;
  copyFile: (src: string, dst: string) => Promise<void>;
}
const realFs: FsLike = { existsSync, copyFile };

/**
 * Copy the kubeconfig file in place as a backup before a mutating action.
 * Returns the backup path, or null when the source is missing or the copy fails
 * (non-fatal: callers proceed and surface that the backup couldn't be written).
 * `stampFn` and `fs` are injectable for tests.
 */
export async function backupKubeconfig(
  kubeconfigPath: string,
  stampFn: () => string = () => backupStamp(new Date()),
  fs: FsLike = realFs,
): Promise<string | null> {
  try {
    if (!fs.existsSync(kubeconfigPath)) return null;
    const dst = backupKubeconfigPath(kubeconfigPath, stampFn());
    await fs.copyFile(kubeconfigPath, dst);
    return dst;
  } catch {
    return null;
  }
}
