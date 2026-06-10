import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, Package, Star, Trash2 } from "lucide-react";
import type { Secret } from "@helmsman/k8s";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  accountsFromSecrets,
  accountId,
  validateForm,
  isFormValid,
  emptyForm,
  previewYAML,
  applyYAML,
  setDefaultId,
  defaultIdAfterAdd,
  defaultIdAfterDelete,
  EMPTY_STATE_MESSAGE,
  type AccountForm,
  type AddMode,
  type RegistryAccount,
} from "./accountsLogic";

// ---------------------------------------------------------------------------
// AccountsPanel — registry pull credentials (docs/parity/accounts.md).
//
// Every account is a kubernetes.io/dockerconfigjson Secret in the cluster; the
// panel keeps NO local disk persistence. The list is derived live from the
// secrets watch store. Only "which row is default" is local UI state.
//
// SECURITY: the access token lives ONLY in the masked input and the `yaml` we
// POST to /api/apply. It is never logged, never shown in the preview (masked as
// [hidden]), and never read back from the cluster.
// ---------------------------------------------------------------------------

interface ApplyResult {
  code: number;
  stdout: string;
  stderr: string;
}

const inputClass =
  "w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

export default function AccountsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  // Local display-only state: which account is the default for installs.
  const [defaultIdState, setDefaultIdState] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RegistryAccount | null>(null);

  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("secrets", ns);
    return () => unsubscribe("secrets", ns);
  }, [namespaceFilter]);

  const accounts = useMemo(
    () =>
      accountsFromSecrets(
        (resources["secrets"] ?? {}) as Record<string, Secret>,
        defaultIdState,
      ),
    [resources, defaultIdState],
  );

  function handleSetDefault(account: RegistryAccount) {
    setDefaultIdState((cur) => setDefaultId(cur, account.id));
  }

  function handleAdded(form: AccountForm) {
    const newId = accountId(form.secretName.trim(), form.namespace.trim());
    setDefaultIdState((cur) =>
      defaultIdAfterAdd(cur, newId, form.makeDefault, accounts.length),
    );
    setShowAdd(false);
  }

  function handleConfirmDelete() {
    if (!pendingDelete) return;
    // Metadata-only removal: drop the default flag if it pointed here. The
    // Secret is intentionally left in the cluster (no kubectl delete). The row
    // disappears only on the next watch delta if the Secret is removed via the
    // Secrets panel — here we just release the default marker.
    setDefaultIdState((cur) => defaultIdAfterDelete(cur, pendingDelete.id));
    setPendingDelete(null);
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div>
          <h1 className="text-lg font-semibold">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Registry pull credentials for catalog installs (Docker Hub, ghcr.io, quay.io).
          </p>
        </div>
        {isLoading && (
          <LoaderCircle className="mt-1 size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <Button className="ml-auto" onClick={() => setShowAdd(true)}>
          Add account
        </Button>
      </div>

      {/* Watch / connection error banner */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Empty state OR list */}
      {!isLoading && accounts.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {EMPTY_STATE_MESSAGE}
        </p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center gap-3 rounded-md border bg-background px-3 py-2"
            >
              <Package className="size-5 text-primary" aria-hidden />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold">{account.registry}</span>
                  {account.isDefault && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      default
                    </span>
                  )}
                  {!account.managed && (
                    <span className="text-xs text-muted-foreground">referenced</span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{account.username || "—"}</span>
                  {" · "}
                  <span className="font-mono">{account.secretName}</span>
                  {" · "}
                  <span className="font-mono">{account.sourceNamespace}</span>
                </div>
              </div>
              <div className="ml-auto flex items-center gap-1">
                {!account.isDefault && (
                  <Button variant="outline" size="sm" onClick={() => handleSetDefault(account)}>
                    <Star className="size-3.5" aria-hidden /> Set default
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${account.registry} account`}
                  onClick={() => setPendingDelete(account)}
                >
                  <Trash2 className="size-4 text-destructive" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddAccountSheet open={showAdd} onClose={() => setShowAdd(false)} onAdded={handleAdded} />

      <DeleteConfirmSheet
        account={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-account sheet (Create | Reference).
// ---------------------------------------------------------------------------

function AddAccountSheet({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (form: AccountForm) => void;
}) {
  const [form, setForm] = useState<AccountForm>(emptyForm());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Reset the form each time the sheet opens (never persist a token in state).
  useEffect(() => {
    if (open) {
      setForm(emptyForm());
      setSubmitted(false);
      setBusy(false);
      setServerError(null);
    }
  }, [open]);

  const errors = validateForm(form);
  const valid = isFormValid(form);

  function set<K extends keyof AccountForm>(key: K, value: AccountForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit() {
    setSubmitted(true);
    setServerError(null);
    if (!valid) return;
    setBusy(true);
    try {
      if (form.mode === "create") {
        const res = await fetch("/api/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ yaml: applyYAML(form) }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
          throw new Error(body.error ?? res.statusText);
        }
        const result = (await res.json()) as ApplyResult;
        if (result.code !== 0) throw new Error(result.stderr || result.stdout || "kubectl apply failed");
      } else {
        // Reference mode: read-only verify the Secret exists via the guarded
        // command action (kubectl get secret <name> -n <ns>).
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "command",
            label: "Verify secret exists",
            args: ["get", "secret", form.secretName.trim(), "-n", form.namespace.trim()],
            destructive: false,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
          throw new Error(body.error ?? res.statusText);
        }
        const result = (await res.json()) as ApplyResult;
        if (result.code !== 0) {
          throw new Error(result.stderr || `Secret "${form.secretName.trim()}" not found in ${form.namespace.trim()}`);
        }
      }
      onAdded(form);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function modeButton(mode: AddMode, label: string) {
    const active = form.mode === mode;
    return (
      <button
        type="button"
        onClick={() => set("mode", mode)}
        aria-pressed={active}
        className={`flex-1 rounded-md px-3 py-1 text-sm ${
          active ? "bg-background shadow-sm font-medium" : "text-muted-foreground"
        }`}
      >
        {label}
      </button>
    );
  }

  function field(
    key: keyof AccountForm,
    label: string,
    opts: { type?: string; placeholder?: string; optional?: boolean } = {},
  ) {
    const err = submitted ? (errors as Record<string, string | undefined>)[key as string] : undefined;
    return (
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {label}
          {opts.optional && <span className="ml-1 text-muted-foreground/60">(optional)</span>}
        </label>
        <input
          type={opts.type ?? "text"}
          value={String(form[key])}
          placeholder={opts.placeholder}
          onChange={(e) => set(key, e.target.value as never)}
          className={inputClass}
          aria-invalid={!!err}
        />
        {err && <p className="text-xs text-destructive">{err}</p>}
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[90vh] overflow-auto">
        <SheetHeader>
          <SheetTitle>Add account</SheetTitle>
          <SheetDescription>
            Store registry pull credentials as a cluster Secret so installs pull authenticated.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4 py-2">
          {/* Mode picker */}
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {modeButton("create", "Create")}
            {modeButton("reference", "Reference existing")}
          </div>

          {field("registry", "Registry", { placeholder: "docker.io" })}
          {field("username", "Username", { optional: form.mode === "reference" })}
          {form.mode === "create" &&
            field("password", "Access token", { type: "password", placeholder: "••••••••" })}
          {field("secretName", "Secret name", { placeholder: "helmsman-dockerhub" })}
          {field("namespace", "Namespace", { placeholder: "default" })}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.makeDefault}
              onChange={(e) => set("makeDefault", e.target.checked)}
            />
            Use as the default for installs
          </label>

          {/* Preview (create mode only) — .dockerconfigjson masked as [hidden]. */}
          {form.mode === "create" && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Preview</p>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all">
                {previewYAML(form)}
              </pre>
            </div>
          )}

          {serverError && (
            <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
              {serverError}
            </pre>
          )}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={busy}>
            {busy ? "Applying…" : form.mode === "create" ? "Create & apply" : "Add reference"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm sheet — metadata-only removal (the Secret stays in cluster).
// ---------------------------------------------------------------------------

function DeleteConfirmSheet({
  account,
  onCancel,
  onConfirm,
}: {
  account: RegistryAccount | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={!!account} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Remove account?</SheetTitle>
          <SheetDescription>
            {account && (
              <span className="font-mono">
                {account.registry}
                {account.username ? ` · ${account.username}` : ""}
              </span>
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 py-2 text-sm text-muted-foreground">
          This removes the account from Helmsman&apos;s list. The Secret will remain in the cluster
          (use the Secrets panel to delete it if needed).
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Remove
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
