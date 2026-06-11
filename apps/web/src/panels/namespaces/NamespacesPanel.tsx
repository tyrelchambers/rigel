import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ListRow } from "@/panels/components/ListRow";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import type { ActionBlock } from "@/lib/api";
import type { Namespace } from "./types";
import type { Pod } from "../pods/types";
import { phaseColorClass, readyText, restartCount, sortPods } from "../pods/podDisplay";
import {
  relativeAge,
  phaseOf,
  podCountInNamespace,
  podCountLabel,
  matchesSearch,
  sortNamespaces,
  isValidNamespaceName,
} from "./namespaceDisplay";
import type { StatusBadgeVariant } from "@/panels/components/StatusBadge";

/** Map a namespace phase to a StatusBadge variant. */
function phaseVariant(phase: string): StatusBadgeVariant {
  switch (phase) {
    case "Active":
      return "healthy";
    case "Terminating":
      return "pending";
    default:
      return "neutral";
  }
}

export default function NamespacesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);

  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  // Namespaces are CLUSTER-SCOPED: always watch '*', never the global
  // namespaceFilter. Also watch pods cluster-wide so the count column is real
  // and expanding a namespace can list its pods. No dependency array entries.
  useEffect(() => {
    subscribe("namespaces", "*");
    subscribe("pods", "*");
    return () => {
      unsubscribe("namespaces", "*");
      unsubscribe("pods", "*");
    };
  }, []);

  // Cmd+N / Ctrl+N opens the create dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openCreate();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const allNamespaces = useMemo(
    () =>
      sortNamespaces(
        Object.values((resources["namespaces"] ?? {}) as Record<string, Namespace>),
      ),
    [resources],
  );

  // Pod count is derived from a (possibly absent) pods watch. If the pods watch
  // is not subscribed, `pods` is null → count column shows "—".
  const pods = useMemo<Pod[] | null>(
    () =>
      resources["pods"]
        ? Object.values(resources["pods"] as Record<string, Pod>)
        : null,
    [resources],
  );

  const filtered = useMemo(
    () => allNamespaces.filter((ns) => matchesSearch(ns, search)),
    [allNamespaces, search],
  );

  const total = allNamespaces.length;
  const shown = filtered.length;

  const trimmedName = newName.trim();
  const nameValid = isValidNamespaceName(trimmedName);

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function openCreate() {
    setNewName("");
    setCreateOpen(true);
  }

  function confirmCreate() {
    if (!nameValid) return;
    setPendingAction({
      kind: "createNamespace",
      name: trimmedName,
      label: `Create namespace ${trimmedName}`,
    });
    setCreateOpen(false);
  }

  function handleDelete(ns: Namespace) {
    setPendingAction({
      kind: "deleteNamespace",
      name: ns.metadata.name,
      destructive: true,
      label: `Delete namespace ${ns.metadata.name}`,
    });
  }

  function askClaude(ns: Namespace, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(buildHandoffPrompt("namespace", ns.metadata.name, undefined, topic));
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Namespaces"
        subtitle="Cluster isolation"
        count={shown !== total && search.trim() ? shown : total}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search namespaces…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3" />
          New
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
        {filtered.map((ns) => {
          const k = ns.metadata.uid || ns.metadata.name;
          const isOpen = expanded.has(k);
          const phase = phaseOf(ns);
          const count = podCountInNamespace(ns, pods);
          const age = relativeAge(ns.metadata.creationTimestamp);
          const nsPods = sortPods(
            (pods ?? []).filter((p) => (p.metadata.namespace ?? "default") === ns.metadata.name),
          );

          return (
            <ListRow
              key={k}
              rowKey={k}
              isOpen={isOpen}
              onToggle={() => toggleExpand(k)}
              expandedContent={
                <div className="space-y-2">
                  <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                    Pods ({nsPods.length})
                  </h3>
                  {nsPods.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No pods in this namespace</p>
                  ) : (
                    <ul className="space-y-1">
                      {nsPods.map((p) => {
                        const restarts = restartCount(p);
                        return (
                          <li
                            key={p.metadata.uid || p.metadata.name}
                            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors"
                            style={{ background: "#0A0A0C", border: "1px solid #1A1A1A" }}
                            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#2A2A2A")}
                            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1A1A1A")}
                          >
                            <span
                              className={`inline-block size-2 shrink-0 rounded-full ${phaseColorClass(p.status?.phase)}`}
                              title={p.status?.phase ?? "Unknown"}
                            />
                            <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
                              {p.metadata.name}
                            </span>
                            {restarts > 0 && (
                              <span
                                className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
                                style={{ background: "rgba(245,158,11,0.15)", color: "#F59E0B" }}
                                title={`${restarts} restart${restarts === 1 ? "" : "s"}`}
                              >
                                ↺{restarts}
                              </span>
                            )}
                            <span
                              className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                              style={{ background: "#141417", border: "1px solid #1A1A1A" }}
                            >
                              {readyText(p)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              }
            >
              {/* Name */}
              <button
                type="button"
                onClick={() => toggleExpand(k)}
                className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
              >
                {ns.metadata.name}
              </button>

              {/* Phase badge */}
              <StatusBadge label={phase} variant={phaseVariant(phase)} />

              {/* Pod count — dim */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "#6B6B73",
                  whiteSpace: "nowrap",
                }}
              >
                {podCountLabel(count)}
              </span>

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
                {age}
              </span>

              {/* Action strip — Errors / Logs / Explain + Delete */}
              <ActionButtonStrip
                onErrors={(e) => { e.stopPropagation(); askClaude(ns, "Errors"); }}
                onLogs={(e) => { e.stopPropagation(); askClaude(ns, "Logs"); }}
                onExplain={(e) => { e.stopPropagation(); askClaude(ns, "Explain"); }}
                extra={[
                  {
                    label: "Delete",
                    Icon: Trash2,
                    onClick: (e) => { e.stopPropagation(); handleDelete(ns); },
                    destructive: true,
                  },
                ]}
              />
            </ListRow>
          );
        })}
      </div>

        {/* Empty / filtered-to-zero states */}
        {!isLoading && allNamespaces.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No namespaces found</p>
        )}
        {!isLoading && allNamespaces.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No namespaces match search</p>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Namespace</DialogTitle>
            <DialogDescription>
              Names use lowercase letters, digits, and hyphens (DNS-1123).
            </DialogDescription>
          </DialogHeader>
          <input
            type="text"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameValid) confirmCreate();
            }}
            placeholder="namespace name"
            aria-label="namespace name"
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmCreate} disabled={!nameValid}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}
