import { useEffect, useMemo, useState } from "react";
import type { Secret, KVRow, SecretTypeId, DockerCredsForm } from "@rigel/k8s";
import {
  CREATABLE_SECRET_TYPES,
  canonicalKeysFor,
  secretTypeId,
  blankRow,
  newRowId,
  buildSecretYAML,
  canSubmitSecret,
  emptyDockerCreds,
  encodeDockerConfigJson,
  parseDockerCredsForm,
  seedSecretRows,
  decodeSecretValue,
} from "@rigel/k8s";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KeyValueEditor } from "../components/KeyValueEditor";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";

// ---------------------------------------------------------------------------
// SecretEditor — create/edit form for a Secret
// (docs/parity/configmap-secret-edit.md). Type picker (Opaque default) drives a
// type-aware data editor; plaintext values are base64-encoded into `data` via
// `buildSecretYAML`. Applies through POST /api/apply (`kubectl apply -f -`).
// On EDIT: name + namespace + type are read-only; binary values are shown
// read-only as `<binary, N bytes>` and cannot be re-encoded.
// ---------------------------------------------------------------------------

interface ApplyResult {
  code: number;
  stdout: string;
  stderr: string;
}

const fieldInput =
  "w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 disabled:cursor-not-allowed";

const DOCKER_TYPE: SecretTypeId = "kubernetes.io/dockerconfigjson";

/** Header title for the type-aware data block. Mirrors `dataBlockTitle`. */
function dataBlockTitle(type: SecretTypeId): string {
  switch (type) {
    case "kubernetes.io/dockerconfigjson":
      return "Docker registry";
    case "kubernetes.io/tls":
      return "TLS certificate";
    case "kubernetes.io/basic-auth":
      return "Basic auth";
    case "kubernetes.io/ssh-auth":
      return "SSH key";
    default:
      return "Data";
  }
}

/** Hint under the data block. Mirrors `typeHint`. */
function typeHint(type: SecretTypeId): string | null {
  switch (type) {
    case "kubernetes.io/dockerconfigjson":
      return "Server, username, password are combined into the canonical .dockerconfigjson JSON payload on submit.";
    case "kubernetes.io/tls":
      return "Paste the certificate and private key in PEM format. Both fields are required by Kubernetes.";
    case "kubernetes.io/basic-auth":
      return "Standard kubernetes.io/basic-auth — fields are 'username' and 'password' on disk.";
    case "kubernetes.io/ssh-auth":
      return "PEM-encoded private key. Kubernetes stores it under the 'ssh-privatekey' key.";
    default:
      return null;
  }
}

export interface SecretEditorProps {
  /** `null` = create; a Secret = edit. */
  target: Secret | null;
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}

export function SecretEditor({ target, open, onClose, onApplied }: SecretEditorProps) {
  const isEdit = target != null;

  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [type, setType] = useState<SecretTypeId>("Opaque");
  const [rows, setRows] = useState<KVRow[]>([blankRow()]);
  const [docker, setDocker] = useState<DockerCredsForm>(emptyDockerCreds());
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const { data: schema } = useClusterYamlSchema();

  // (Re)seed each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setServerError(null);
    setMode("form");
    if (target) {
      const t = secretTypeId(target.type);
      setName(target.metadata.name);
      setNamespace(target.metadata.namespace ?? "default");
      setType(t);
      setRows(seedSecretRows(target));
      if (t === DOCKER_TYPE) {
        const payload = target.data?.[".dockerconfigjson"];
        const decoded = payload != null ? decodeSecretValue(payload) : null;
        const parsed = decoded != null ? parseDockerCredsForm(decoded) : null;
        setDocker(parsed ?? emptyDockerCreds());
      } else {
        setDocker(emptyDockerCreds());
      }
    } else {
      setName("");
      setNamespace("default");
      setType("Opaque");
      setRows([blankRow()]);
      setDocker(emptyDockerCreds());
    }
  }, [open, target]);

  // Switching types in CREATE mode resets rows to the new type's canonical keys.
  function applyTypeChange(next: SecretTypeId) {
    if (next === type) return;
    setType(next);
    const keys = canonicalKeysFor(next);
    setRows(
      keys.length === 0
        ? [blankRow()]
        : keys.map((k) => ({ id: newRowId(), key: k, value: "" })),
    );
  }

  const valid = canSubmitSecret(name, namespace, type, rows, docker);

  // Build the data the YAML emitter needs: plaintext rows are base64-encoded by
  // buildSecretYAML; binary rows (edit-only) and the docker payload are passed
  // pre-encoded so they're carried through verbatim.
  const yaml = useMemo(() => {
    const decodedData: Record<string, string> = {};
    const preEncoded: Record<string, string> = {};

    if (type === DOCKER_TYPE) {
      preEncoded[".dockerconfigjson"] = encodeDockerConfigJson(docker);
    } else {
      for (const r of rows) {
        const key = r.key.trim();
        if (key === "") continue;
        if (r.binary && target?.data?.[key] != null) {
          // Binary value carried through unchanged (already base64 on the wire).
          preEncoded[key] = target.data[key]!;
        } else if (!r.binary) {
          decodedData[key] = r.value;
        }
      }
    }

    return buildSecretYAML(name.trim(), namespace.trim(), type, decodedData, preEncoded);
  }, [name, namespace, type, rows, docker, target]);

  async function handleApply() {
    setServerError(null);
    if (!valid) return;
    setBusy(true);
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
          error?: string;
        };
        throw new Error(body.error ?? res.statusText);
      }
      const result = (await res.json()) as ApplyResult;
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || "kubectl apply failed");
      }
      onApplied?.();
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const pinnedKeys = canonicalKeysFor(type);
  const hint = typeHint(type);

  function setDockerField(key: keyof DockerCredsForm, value: string) {
    setDocker((d) => ({ ...d, [key]: value }));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-w-3xl max-h-[84vh] overflow-auto">
        <div className="flex flex-col gap-0.5 p-4">
          <DialogTitle>{isEdit ? `Edit ${name}` : "New Secret"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Modify the secret data. Name, namespace, and type are fixed; binary values are read-only."
              : "Create a Secret. Plaintext values are base64-encoded into the manifest on apply."}
          </DialogDescription>
        </div>

        {/* Form ⇄ YAML preview toggle */}
        <div className="flex items-center gap-1 px-4 pt-1">
          <Button size="sm" variant={mode === "form" ? "default" : "outline"} onClick={() => setMode("form")}>Form</Button>
          <Button size="sm" variant={mode === "yaml" ? "default" : "outline"} onClick={() => setMode("yaml")}>YAML</Button>
        </div>

        {mode === "form" ? (
        <div className="space-y-4 px-4 py-2">
          {/* Metadata */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <input
                type="text"
                value={name}
                placeholder="my-secret"
                disabled={isEdit}
                onChange={(e) => setName(e.target.value)}
                className={fieldInput}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Namespace</label>
              <input
                type="text"
                value={namespace}
                placeholder="default"
                disabled={isEdit}
                onChange={(e) => setNamespace(e.target.value)}
                className={fieldInput}
              />
            </div>
          </div>

          {/* Type picker */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            {isEdit ? (
              <div className="flex items-center gap-2">
                <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {CREATABLE_SECRET_TYPES.find((t) => t.id === type)?.displayName ?? "Opaque"}
                </span>
                <span className="text-xs text-muted-foreground">
                  (type can&apos;t be changed after creation)
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {CREATABLE_SECRET_TYPES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={type === t.id}
                    onClick={() => applyTypeChange(t.id)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                      type === t.id
                        ? "border-transparent bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t.displayName}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Type-aware data editor */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {dataBlockTitle(type)}
            </label>

            {type === DOCKER_TYPE ? (
              <div className="space-y-3">
                <DockerField
                  label="Registry server"
                  placeholder="ghcr.io"
                  value={docker.server}
                  onChange={(v) => setDockerField("server", v)}
                />
                <DockerField
                  label="Username"
                  placeholder="user"
                  value={docker.username}
                  onChange={(v) => setDockerField("username", v)}
                />
                <DockerField
                  label="Password / token"
                  placeholder="••••••••"
                  type="password"
                  value={docker.password}
                  onChange={(v) => setDockerField("password", v)}
                />
                <DockerField
                  label="Email"
                  placeholder="user@example.com"
                  optional
                  value={docker.email}
                  onChange={(v) => setDockerField("email", v)}
                />
              </div>
            ) : (
              <KeyValueEditor
                rows={rows}
                onRowsChange={setRows}
                readonlyKeyNames={pinnedKeys}
                fixedRows={pinnedKeys.length > 0}
                keyPlaceholder="key"
                maskValues={type === "kubernetes.io/basic-auth"}
              />
            )}

            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          </div>

        </div>
        ) : (
          <div className="space-y-2 px-4 py-2">
            <p className="text-xs text-muted-foreground">
              Live preview of the manifest applied with <code className="font-mono">kubectl apply -f -</code>. Plaintext values are base64-encoded.
            </p>
            <div className="h-[52vh] w-full overflow-hidden rounded-md border" style={{ background: "#0B0C0E", borderColor: "#26272B" }}>
              <YamlEditor value={yaml} readOnly schema={schema ?? null} />
            </div>
          </div>
        )}

        {serverError && (
          <pre className="mx-4 rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {serverError}
          </pre>
        )}

        <div className="mt-auto flex flex-col gap-2 p-4">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={busy || !valid}>
            {busy ? "Applying…" : isEdit ? "Apply changes" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DockerField({
  label,
  placeholder,
  value,
  onChange,
  type = "text",
  optional = false,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  optional?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
        {optional && <span className="ml-1 text-muted-foreground/60">(optional)</span>}
      </label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={fieldInput}
      />
    </div>
  );
}
