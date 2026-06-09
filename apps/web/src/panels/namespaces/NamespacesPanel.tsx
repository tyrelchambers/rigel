import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, SquareDashed, Trash2, Plus } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import type { Namespace } from "./types";
import type { Pod } from "../pods/types";
import {
  relativeAge,
  phaseOf,
  namespacePhaseColorClass,
  podCountInNamespace,
  podCountLabel,
  matchesSearch,
  sortNamespaces,
  isValidNamespaceName,
} from "./namespaceDisplay";

export default function NamespacesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);

  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  // Namespaces are CLUSTER-SCOPED: always watch '*', never the global
  // namespaceFilter. No dependency array entries.
  useEffect(() => {
    subscribe("namespaces", "*");
    return () => unsubscribe("namespaces", "*");
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
  const countLabel = search.trim() && shown !== total ? `${shown} / ${total}` : `${total}`;

  const trimmedName = newName.trim();
  const nameValid = isValidNamespaceName(trimmedName);

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

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Namespaces</h1>
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
          placeholder="Search namespaces…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button size="sm" onClick={openCreate}>
          <Plus />
          New
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
            <TableHead>Name</TableHead>
            <TableHead>Phase</TableHead>
            <TableHead>Pods</TableHead>
            <TableHead>Age</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((ns) => {
            const phase = phaseOf(ns);
            const count = podCountInNamespace(ns, pods);
            return (
              <TableRow key={ns.metadata.uid || ns.metadata.name}>
                <TableCell className="align-middle text-muted-foreground">
                  <SquareDashed className="size-4" aria-hidden />
                </TableCell>
                <TableCell className="font-mono whitespace-nowrap">{ns.metadata.name}</TableCell>
                <TableCell>
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${namespacePhaseColorClass(phase)}`}
                  >
                    {phase}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {podCountLabel(count)}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {relativeAge(ns.metadata.creationTimestamp)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete namespace ${ns.metadata.name}`}
                    title="Delete"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDelete(ns)}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && allNamespaces.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No namespaces found</p>
      )}
      {!isLoading && allNamespaces.length > 0 && filtered.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No namespaces match search</p>
      )}

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
