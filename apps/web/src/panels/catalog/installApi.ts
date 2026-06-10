// Catalog install HTTP mutations — POST /api/apply (manifest mode) and
// POST /api/helm (helm mode). Both return { code, stdout, stderr }, mirroring
// the server's install executors (docs/parity/catalog.md §"Execution").
import { useMutation } from "@tanstack/react-query";

export interface InstallResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HelmInstallParams {
  repoName: string;
  repoURL: string;
  chart: string;
  version?: string | null;
  releaseName: string;
  namespace: string;
  values: string;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

/** POST the final, substituted multi-doc YAML to `kubectl apply -f -` (via stdin). */
export function applyManifest(yaml: string): Promise<InstallResult> {
  return postJSON<InstallResult>("/api/apply", { yaml });
}

/** POST the helm descriptor + values to run `helm upgrade --install`. */
export function installHelm(params: HelmInstallParams): Promise<InstallResult> {
  return postJSON<InstallResult>("/api/helm", params);
}

/** TanStack mutation for the manifest-mode apply. */
export function useApplyManifest() {
  return useMutation<InstallResult, Error, string>({ mutationFn: applyManifest });
}

/** TanStack mutation for the helm-mode install. */
export function useInstallHelm() {
  return useMutation<InstallResult, Error, HelmInstallParams>({
    mutationFn: installHelm,
  });
}
