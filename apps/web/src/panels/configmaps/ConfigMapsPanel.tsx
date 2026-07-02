import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { viewYaml, editYaml } from "@/store/yamlViewer";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ListRow } from "@/panels/components/ListRow";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { useFocusRow } from "@/panels/components/useFocusRow";
import type { ConfigMap } from "./types";
import { ConfigMapEditor } from "./ConfigMapEditor";
import { ConfigMapDetail } from "./ConfigMapDetail";
import { relativeAge, keyCount, matchesSearch, sortConfigMaps } from "./configmapsDisplay";

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

  useFocusRow("configmap", allConfigMaps, (cm) => cm.metadata.uid, (k) => setExpanded((prev) => new Set(prev).add(k)));

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

          const rowMenu = (
            <>
              <ContextMenuItem onClick={() => askClaude(cm, "Errors")}>Ask Claude: Errors</ContextMenuItem>
              <ContextMenuItem onClick={() => askClaude(cm, "Logs")}>Ask Claude: Logs</ContextMenuItem>
              <ContextMenuItem onClick={() => askClaude(cm, "Explain")}>Ask Claude: Explain</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => openEdit(cm)}>Edit…</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => viewYaml("configmap", cm.metadata.name, cm.metadata.namespace)}>View YAML…</ContextMenuItem>
              <ContextMenuItem onClick={() => editYaml("configmap", cm.metadata.name, cm.metadata.namespace)}>Edit YAML…</ContextMenuItem>
              <ContextMenuItem onClick={() => toggleExpand(uid)}>{isOpen ? "Collapse" : "Manage…"}</ContextMenuItem>
            </>
          );

          return (
            <ListRow
              key={uid}
              rowKey={uid}
              isOpen={isOpen}
              onToggle={() => toggleExpand(uid)}
              contextMenu={rowMenu}
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
                  color: "var(--fg-tertiary)",
                  background: "var(--surface-sunken)",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid #26272B",
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
                  color: "var(--fg-tertiary)",
                  whiteSpace: "nowrap",
                }}
              >
                {relativeAge(cm.metadata.creationTimestamp)}
              </span>
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
