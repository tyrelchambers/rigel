/** What a destination check reports back. No secret value ever appears here. */
export interface FailoverValidation {
  ok: boolean;
  api: { ok: true; email: string } | { ok: false; status?: number; error: string };
  options?: {
    regions: Array<{ slug: string; name: string }>;
    sizes: Array<{ slug: string; name: string }>;
  };
  objectStore?:
    | { ok: true; bucketExists: boolean; insideSourceCluster: boolean }
    | { ok: false; code?: string; error: string };
}

export function validationPassed(v: FailoverValidation): boolean {
  if (!v.api.ok) return false;
  return v.objectStore ? v.objectStore.ok : true;
}
