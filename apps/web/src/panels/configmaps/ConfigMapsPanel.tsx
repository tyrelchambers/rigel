import { Fragment, useEffect, useMemo, useState } from "react";
import { LoaderCircle, ChevronRight, ChevronDown, CircleDashed, FileArchive, Plus, Pencil } from "lucide-react";
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
import type { ConfigMap } from "./types";
import { ConfigMapEditor } from "./ConfigMapEditor";
import {
  relativeAge,
  keyCount,
  binaryKeyCount,
  keysSorted,
  isBinaryKey,
  plaintextBytes,
  binaryBytes,
  matchesSearch,
  sortConfigMaps,
} from "./configmapsDisplay";

// ---------------------------------------------------------------------------
// CREATE + EDIT are implemented via ConfigMapEditor → POST /api/apply
// (`kubectl apply -f -`); see docs/parity/configmap-secret-edit.md. The watch
// auto-refreshes the list after a successful apply. Still DEFERRED (need new
// infra / specs): Delete mutation, standalone View-YAML, copy-to-clipboard.
// ---------------------------------------------------------------------------

/** "0 keys" / "1 key" / "N keys" with correct pluralization. */
function keysLabel(n: number): string {
  return `${n} ${n === 1 ? "key" : "keys"}`;
}

export default function ConfigMapsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Editor sheet: `editorOpen` true; `editTarget` null = create, else edit.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ConfigMap | null>(null);

  function openCreate() {
    setEditTarget(null);
    setEditorOpen(true);
  }
  function openEdit(cm: ConfigMap) {
    setEditTarget(cm);
    setEditorOpen(true);
  }

  // Subscribe to the configmaps watch for the active namespace (or all).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("configmaps", ns);
    return () => unsubscribe("configmaps", ns);
  }, [namespaceFilter]);

  const allConfigMaps = useMemo(
    () =>
      sortConfigMaps(
        Object.values((resources["configmaps"] ?? {}) as Record<string, ConfigMap>),
      ),
    [resources],
  );
  const filtered = useMemo(
    () => allConfigMaps.filter((c) => matchesSearch(c, search)),
    [allConfigMaps, search],
  );

  const total = allConfigMaps.length;
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
        <h1 className="text-lg font-semibold">ConfigMaps</h1>
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
          placeholder="Search configmaps…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" aria-hidden /> New ConfigMap
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
            <TableHead>Namespace</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Keys</TableHead>
            <TableHead>Age</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((cm) => {
            const uid = cm.metadata.uid;
            const isOpen = expanded.has(uid);
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
                  <TableCell className="font-mono text-muted-foreground">
                    {cm.metadata.namespace ?? "—"}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => toggleExpand(uid)}
                      className="font-mono hover:underline"
                    >
                      {cm.metadata.name}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {keysLabel(keyCount(cm))}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {relativeAge(cm.metadata.creationTimestamp)}
                  </TableCell>
                </TableRow>

                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-muted/30">
                      <ConfigMapDetail configMap={cm} onEdit={() => openEdit(cm)} />
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
        <p className="px-2 py-4 text-sm text-muted-foreground">No configmaps found</p>
      )}

      <ConfigMapEditor
        target={editTarget}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onApplied={() => setEditorOpen(false)}
      />
    </div>
  );
}

/** Expanded detail: STATUS summary + KEYS section (sorted, with values). */
function ConfigMapDetail({ configMap, onEdit }: { configMap: ConfigMap; onEdit: () => void }) {
  const keys = keysSorted(configMap);
  const total = keyCount(configMap);
  const binary = binaryKeyCount(configMap);
  const labelEntries = Object.entries(configMap.metadata.labels ?? {});

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
        <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
          <dt className="text-muted-foreground">KEYS</dt>
          <dd>{total}</dd>
          {binary > 0 && (
            <>
              <dt className="text-muted-foreground">BINARY</dt>
              <dd>{binary}</dd>
            </>
          )}
          <dt className="text-muted-foreground">AGE</dt>
          <dd>{relativeAge(configMap.metadata.creationTimestamp)}</dd>
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
              const binaryKey = isBinaryKey(configMap, key);
              if (binaryKey) {
                const bytes = binaryBytes(configMap.binaryData?.[key] ?? "");
                return (
                  <li key={key} className="rounded-md border bg-background/40 p-2">
                    <div className="flex items-center gap-2">
                      <FileArchive className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="select-text font-mono text-xs">{key}</span>
                    </div>
                    <p className="mt-1 rounded-md p-2 text-xs font-mono text-muted-foreground/70">
                      {`<binary, ${bytes} bytes>`}
                    </p>
                  </li>
                );
              }
              const value = configMap.data?.[key] ?? "";
              const bytes = plaintextBytes(value);
              return (
                <li key={key} className="rounded-md border bg-background/40 p-2">
                  <div className="flex items-center gap-2">
                    <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />
                    <span className="select-text font-mono text-xs">{key}</span>
                    <span className="font-mono text-xs text-muted-foreground">{bytes}B</span>
                  </div>
                  <pre className="mt-1 max-h-[200px] select-text overflow-auto rounded-md border p-2 text-xs font-mono text-muted-foreground/80 whitespace-pre-wrap break-all">
                    {value}
                  </pre>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
