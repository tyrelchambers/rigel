import { Fragment, useEffect, useMemo, useState } from "react";
import { LoaderCircle, ChevronRight, ChevronDown, KeyRound, Eye, EyeOff, Plus, Pencil } from "lucide-react";
import type { Secret } from "@helmsman/k8s";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { SecretEditor } from "./SecretEditor";
import {
  relativeAge,
  keyCount,
  keysSorted,
  secretTypeDisplayName,
  decoded,
  rawBytes,
  matchesSearch,
  sortSecrets,
} from "./secretsDisplay";

// ---------------------------------------------------------------------------
// CREATE + EDIT are implemented via SecretEditor → POST /api/apply
// (`kubectl apply -f -`); see docs/parity/configmap-secret-edit.md. Plaintext
// values are base64-encoded into the manifest; binary values are read-only on
// edit. The watch auto-refreshes after a successful apply. Still DEFERRED (need
// new infra / specs): Delete mutation, move-to-namespace, standalone View-YAML,
// copy-to-clipboard. Reveal is purely client-side base64 decoding; values are
// never searched.
// ---------------------------------------------------------------------------

/** "0 keys" / "1 key" / "N keys" with correct pluralization. */
function keysLabel(n: number): string {
  return `${n} ${n === 1 ? "key" : "keys"}`;
}

export default function SecretsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Editor sheet: `editorOpen` true; `editTarget` null = create, else edit.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Secret | null>(null);

  function openCreate() {
    setEditTarget(null);
    setEditorOpen(true);
  }
  function openEdit(secret: Secret) {
    setEditTarget(secret);
    setEditorOpen(true);
  }

  // Subscribe to the secrets watch for the active namespace (or all).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("secrets", ns);
    return () => unsubscribe("secrets", ns);
  }, [namespaceFilter]);

  const allSecrets = useMemo(
    () =>
      sortSecrets(
        Object.values((resources["secrets"] ?? {}) as Record<string, Secret>),
      ),
    [resources],
  );
  const filtered = useMemo(
    () => allSecrets.filter((s) => matchesSearch(s, search)),
    [allSecrets, search],
  );

  const total = allSecrets.length;
  const shown = filtered.length;
  const countLabel = search.trim() && shown !== total ? `${shown} / ${total}` : `${total}`;

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Secrets</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
          {countLabel}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search secrets…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" aria-hidden /> New Secret
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6" />
            <TableHead className="w-3" />
            <TableHead>Name</TableHead>
            <TableHead>Namespace</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Keys</TableHead>
            <TableHead className="text-right">Age</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((secret) => {
            const uid = secret.metadata.uid;
            const isOpen = expanded.has(uid);
            const displayType = secretTypeDisplayName(secret.type);
            const rawType = secret.type ?? "Opaque";
            return (
              <Fragment key={uid}>
                <TableRow>
                  <TableCell className="align-top">
                    <button
                      type="button"
                      onClick={() => toggleExpand(uid)}
                      aria-label={isOpen ? "Collapse" : "Expand"}
                      aria-expanded={isOpen}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                  </TableCell>
                  <TableCell className="align-top">
                    <KeyRound className="size-3 text-primary" aria-hidden />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => toggleExpand(uid)}
                      className="font-mono hover:underline"
                    >
                      {secret.metadata.name}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {secret.metadata.namespace ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span
                      title={rawType}
                      className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                    >
                      {displayType}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {keysLabel(keyCount(secret))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {relativeAge(secret.metadata.creationTimestamp)}
                  </TableCell>
                </TableRow>

                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={7} className="bg-muted/30">
                      <SecretDetail secret={secret} onEdit={() => openEdit(secret)} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && filtered.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No secrets found</p>
      )}

      <SecretEditor
        target={editTarget}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onApplied={() => setEditorOpen(false)}
      />
    </div>
  );
}

/** Expanded detail: STATUS summary + KEYS section (sorted, reveal toggles). */
function SecretDetail({ secret, onEdit }: { secret: Secret; onEdit: () => void }) {
  const keys = keysSorted(secret);
  const total = keyCount(secret);
  const displayType = secretTypeDisplayName(secret.type);
  const rawType = secret.type ?? "Opaque";
  const labelEntries = Object.entries(secret.metadata.labels ?? {});

  // Per-key reveal state (Set of revealed key names). Local, not persisted.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  function toggleReveal(key: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="space-y-3 px-2 py-3">
      {/* Actions */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="size-3.5" aria-hidden /> Edit
        </Button>
      </div>

      {/* STATUS */}
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Status
        </h3>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
          <dt className="text-muted-foreground">TYPE</dt>
          <dd>{displayType}</dd>
          <dt className="text-muted-foreground">RAW TYPE</dt>
          <dd className="break-all">{rawType}</dd>
          <dt className="text-muted-foreground">KEYS</dt>
          <dd>{total}</dd>
          <dt className="text-muted-foreground">AGE</dt>
          <dd>{relativeAge(secret.metadata.creationTimestamp)}</dd>
          {labelEntries.length > 0 && (
            <>
              <dt className="text-muted-foreground">LABELS</dt>
              <dd className="break-all">
                {labelEntries.map(([k, v]) => `${k}=${v}`).join(", ")}
              </dd>
            </>
          )}
        </dl>
      </div>

      {/* KEYS */}
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Keys ({total})
        </h3>
        {keys.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">No data keys</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((key) => {
              const bytes = rawBytes(secret, key);
              const isRevealed = revealed.has(key);
              const value = isRevealed ? decoded(secret, key) : null;
              return (
                <li key={key} className="rounded-md border bg-background/40 p-2">
                  <div className="flex items-center gap-2">
                    <span className="select-text font-mono text-xs">{key}</span>
                    <span className="font-mono text-xs text-muted-foreground">{bytes}B</span>
                    <button
                      type="button"
                      onClick={() => toggleReveal(key)}
                      aria-pressed={isRevealed}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {isRevealed ? (
                        <>
                          <EyeOff className="size-3" aria-hidden /> Hide
                        </>
                      ) : (
                        <>
                          <Eye className="size-3" aria-hidden /> Reveal
                        </>
                      )}
                    </button>
                  </div>
                  {isRevealed ? (
                    value == null ? (
                      <p className="mt-1 select-text rounded-md border p-2 text-xs font-mono text-muted-foreground/70">
                        {`<binary, ${bytes} bytes>`}
                      </p>
                    ) : (
                      <pre className="mt-1 max-h-[200px] select-text overflow-auto rounded-md border p-2 text-xs font-mono text-muted-foreground/80 whitespace-pre-wrap break-all">
                        {value}
                      </pre>
                    )
                  ) : (
                    <p className="mt-1 select-none p-2 text-xs font-mono tracking-widest text-muted-foreground/60">
                      ••••••••
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
