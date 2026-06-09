import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import type { Pod } from "./types";
import {
  relativeAge,
  phaseColorClass,
  readyText,
  restartCount,
  matchesSearch,
  sortPods,
} from "./podDisplay";

export default function PodsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);

  // Subscribe to the pods watch for the active namespace (or all namespaces).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("pods", ns);
    return () => unsubscribe("pods", ns);
  }, [namespaceFilter]);

  const allPods = useMemo(
    () => sortPods(Object.values((resources["pods"] ?? {}) as Record<string, Pod>)),
    [resources],
  );
  const filtered = useMemo(
    () => allPods.filter((p) => matchesSearch(p, search)),
    [allPods, search],
  );

  const total = allPods.length;
  const shown = filtered.length;
  const countLabel = search.trim() && shown !== total ? `${shown} / ${total}` : `${total}`;

  function handleDelete(pod: Pod) {
    const ns = pod.metadata.namespace ?? "default";
    setPendingAction({
      kind: "deletePod",
      pod: pod.metadata.name,
      namespace: ns,
      destructive: true,
      label: `Delete pod ${pod.metadata.name}`,
    });
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Pods</h1>
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
          placeholder="Search pods…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
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
            <TableHead>Namespace</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Ready</TableHead>
            <TableHead>Restarts</TableHead>
            <TableHead>Node</TableHead>
            <TableHead>Age</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((pod) => {
            const phase = pod.status?.phase;
            const restarts = restartCount(pod);
            return (
              <TableRow key={pod.metadata.uid || `${pod.metadata.namespace}/${pod.metadata.name}`}>
                <TableCell className="font-mono text-muted-foreground">
                  {pod.metadata.namespace ?? "—"}
                </TableCell>
                <TableCell className="font-mono">{pod.metadata.name}</TableCell>
                <TableCell>
                  {phase ? (
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${phaseColorClass(phase)}`}
                    >
                      {phase}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">{readyText(pod)}</TableCell>
                <TableCell
                  className={`font-mono ${restarts > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
                >
                  {restarts}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {pod.spec?.nodeName ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {relativeAge(pod.metadata.creationTimestamp)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDelete(pod)}
                  >
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {filtered.length === 0 && !isLoading && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No pods found</p>
      )}

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}
