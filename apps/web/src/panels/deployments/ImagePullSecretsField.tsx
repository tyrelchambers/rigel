import { X } from "lucide-react";
import type { Secret } from "@helmsman/k8s";

// ---------------------------------------------------------------------------
// ImagePullSecretsField — deployment-level picker for pod imagePullSecrets,
// used to pull images from private registries (e.g. GHCR). Lists namespace
// secrets of a docker-registry type as add options; selected names render as
// removable chips. Diffed by `diffDeployment` into a `setImagePullSecrets`
// merge patch (full desired list).
// ---------------------------------------------------------------------------

const REGISTRY_TYPES = new Set(["kubernetes.io/dockerconfigjson", "kubernetes.io/dockercfg"]);
const selectClass =
  "rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring";

export interface ImagePullSecretsFieldProps {
  value: string[];
  secrets: Secret[];
  onChange: (next: string[]) => void;
}

export function ImagePullSecretsField({ value, secrets, onChange }: ImagePullSecretsFieldProps) {
  const available = secrets.filter(
    (s) => REGISTRY_TYPES.has(s.type ?? "") && !value.includes(s.metadata.name),
  );

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Image pull secrets</div>
      <p className="text-[11px] text-muted-foreground">Authenticate to private registries (e.g. GHCR) when pulling images.</p>
      <div className="flex flex-wrap items-center gap-2">
        {value.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
        {value.map((n) => (
          <span key={n} className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs font-mono">
            {n}
            <button
              type="button"
              aria-label={`Remove ${n}`}
              onClick={() => onChange(value.filter((x) => x !== n))}
              className="text-destructive hover:opacity-70"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <select
        value=""
        onChange={(e) => {
          const name = e.target.value;
          if (name && !value.includes(name)) onChange([...value, name]);
        }}
        className={selectClass}
        aria-label="Add image pull secret"
      >
        <option value="">+ Add registry secret…</option>
        {available.map((s) => (
          <option key={s.metadata.name} value={s.metadata.name}>{s.metadata.name}</option>
        ))}
      </select>
    </div>
  );
}
