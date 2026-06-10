import { useEffect, useMemo, useState } from "react";
import { CircleDashed, FileArchive, Plus, Pencil } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/panels/components/ListRow";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { PanelHeader } from "@/panels/components/PanelHeader";
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
// auto-refreshes the list after a successful apply.
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

  const shown = filtered.length;

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function askClaude(cm: ConfigMap, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(buildHandoffPrompt("configmap", cm.metadata.name, cm.metadata.namespace, topic));
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="ConfigMaps"
        subtitle="Configuration data"
        count={shown}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search configmaps…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" aria-hidden /> New ConfigMap
        </Button>
      </PanelHeader>

      <div className="flex-1 overflow-auto">
        {/* Error banner */}
        {error && (
          <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}

        {/* Row list */}
        <div className="flex flex-col gap-0.5 px-3 py-2">
        {filtered.map((cm) => {
          const uid = cm.metadata.uid;
          const isOpen = expanded.has(uid);
          const keys = keyCount(cm);

          return (
            <ListRow
              key={uid}
              rowKey={uid}
              isOpen={isOpen}
              onToggle={() => toggleExpand(uid)}
              expandedContent={
                <ConfigMapDetail configMap={cm} onEdit={() => openEdit(cm)} />
              }
            >
              {/* Name */}
              <button
                type="button"
                onClick={() => toggleExpand(uid)}
                className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
              >
                {cm.metadata.name}
              </button>

              {/* Namespace chip */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "#6B6B73",
                  background: "#050505",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid #1A1A1A",
                  whiteSpace: "nowrap",
                }}
              >
                {cm.metadata.namespace ?? "—"}
              </span>

              {/* Key count — neutral pill */}
              <StatusBadge label={keysLabel(keys)} variant="neutral" />

              {/* Spacer */}
              <span className="flex-1" />

              {/* Age — dim */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "#6B6B73",
                  whiteSpace: "nowrap",
                }}
              >
                {relativeAge(cm.metadata.creationTimestamp)}
              </span>

              {/* Action button strip — Errors / Logs / Explain + Edit */}
              <ActionButtonStrip
                onErrors={(e) => { e.stopPropagation(); askClaude(cm, "Errors"); }}
                onLogs={(e) => { e.stopPropagation(); askClaude(cm, "Logs"); }}
                onExplain={(e) => { e.stopPropagation(); askClaude(cm, "Explain"); }}
                extra={[
                  {
                    label: "Edit",
                    Icon: Pencil,
                    onClick: (e) => { e.stopPropagation(); openEdit(cm); },
                  },
                ]}
              />
            </ListRow>
          );
        })}
      </div>

        {/* Empty / filtered-to-zero states */}
        {!isLoading && allConfigMaps.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No configmaps found</p>
        )}
        {!isLoading && allConfigMaps.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No configmaps match search</p>
        )}
      </div>

      <ConfigMapEditor
        target={editTarget}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onApplied={() => setEditorOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail: STATUS summary + KEYS section (sorted, with values).
// ---------------------------------------------------------------------------

/** Expanded detail: STATUS summary + KEYS section (sorted, with values). */
function ConfigMapDetail({ configMap, onEdit }: { configMap: ConfigMap; onEdit: () => void }) {
  const keys = keysSorted(configMap);
  const total = keyCount(configMap);
  const binary = binaryKeyCount(configMap);
  const labelEntries = Object.entries(configMap.metadata.labels ?? {});

  return (
    <div className="space-y-3">
      {/* STATUS */}
      <div className="space-y-1">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
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
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
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

      {/* Edit button */}
      <div
        className="flex items-center gap-2 border-t pt-3"
        style={{ borderColor: "#1A1A1A" }}
      >
        <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground mr-2">
          Manage
        </span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={onEdit}>
          <Pencil className="size-3" />
          Edit
        </Button>
      </div>
    </div>
  );
}
