import { useState } from "react";
import {
  Boxes,
  Package,
  FileCode,
  Layers,
  RotateCcw,
  History,
  type LucideIcon,
} from "lucide-react";
import { useRecentDeploys, useUndoDeploy } from "@/lib/api";
import type { RecentBatch } from "@rigel/k8s";
import { spelledAge } from "@/lib/time";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const BORDER_SUBTLE = "#26272B";
const RED = "var(--status-failed)";

interface SourceMeta {
  label: string;
  icon: LucideIcon;
  tint: string;
}

function sourceMeta(source: string): SourceMeta {
  switch (source) {
    case "compose-migration":
      return { label: "Compose migration", icon: Boxes, tint: "var(--accent-primary)" };
    case "catalog-install":
      return { label: "Catalog install", icon: Package, tint: "#A855F7" };
    case "apply-yaml":
      return { label: "Apply YAML", icon: FileCode, tint: "#2DD4BF" };
    default:
      return { label: source, icon: Layers, tint: "var(--fg-secondary)" };
  }
}

function batchNamespaces(b: RecentBatch): string {
  const uniq = [...new Set(b.resources.map((r) => r.namespace).filter(Boolean))];
  return uniq.length ? uniq.join(", ") : "—";
}

export function RecentDeploysCard() {
  const { data } = useRecentDeploys();
  const batches = data?.batches ?? [];
  const [confirm, setConfirm] = useState<RecentBatch | null>(null);

  return (
    <div
      style={{
        background: "var(--surface-elevated)",
        borderRadius: 8,
        border: `1px solid ${BORDER_SUBTLE}`,
        overflow: "hidden",
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ padding: "12px 14px", borderBottom: `1px solid ${BORDER_SUBTLE}` }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-primary)" }}>
          Recent deployments
        </span>
        <span className="font-mono text-2xs" style={{ color: "var(--fg-tertiary)" }}>
          {batches.length} in the last 14 days
        </span>
      </div>

      {batches.length === 0 ? (
        <EmptyState />
      ) : (
        batches.map((b, i) => (
          <DeployRow
            key={b.batchId}
            batch={b}
            last={i === batches.length - 1}
            onUndo={() => setConfirm(b)}
          />
        ))
      )}

      <UndoConfirm
        batch={confirm}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function DeployRow({
  batch,
  last,
  onUndo,
}: {
  batch: RecentBatch;
  last: boolean;
  onUndo: () => void;
}) {
  const meta = sourceMeta(batch.source);
  const Icon = meta.icon;
  const ns = batchNamespaces(batch);
  const age = spelledAge(batch.appliedAt);
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: "13px 14px",
        borderBottom: last ? "none" : `1px solid ${BORDER_SUBTLE}`,
      }}
    >
      <div className="flex items-center" style={{ gap: 11, minWidth: 0 }}>
        <Icon size={16} style={{ color: meta.tint, flexShrink: 0 }} />
        <div className="flex flex-col" style={{ gap: 3, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-primary)" }}>
            {meta.label}
          </span>
          <span
            className="font-mono text-2xs"
            style={{
              color: "var(--fg-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {batch.resources.length} resources · namespace {ns} · {age} ago
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onUndo}
        className="inline-flex items-center text-xs"
        style={{
          gap: 6,
          flexShrink: 0,
          background: "var(--surface-sunken)",
          border: `1px solid ${BORDER_SUBTLE}`,
          borderRadius: 6,
          padding: "5px 10px",
          color: "var(--fg-secondary)",
        }}
      >
        <RotateCcw size={13} /> Undo
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center"
      style={{ padding: 34, gap: 10, textAlign: "center" }}
    >
      <span
        className="inline-flex items-center justify-center"
        style={{ width: 46, height: 46, borderRadius: "50%", background: "#38BDF826" }}
      >
        <History size={22} style={{ color: "var(--accent-primary)" }} />
      </span>
      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-primary)" }}>
        Nothing applied recently
      </span>
      <p
        style={{ fontSize: 12.5, color: "var(--fg-secondary)", maxWidth: 320, margin: 0 }}
      >
        Migrations, catalog installs, and Apply YAML you run through Rigel show up
        here, ready to undo.
      </p>
      <span className="font-mono text-2xs" style={{ color: "var(--fg-tertiary)" }}>
        Undo stays available for 14 days
      </span>
    </div>
  );
}

function UndoConfirm({
  batch,
  onClose,
}: {
  batch: RecentBatch | null;
  onClose: () => void;
}) {
  const undo = useUndoDeploy();
  if (!batch) return null;
  const meta = sourceMeta(batch.source);
  const count = batch.resources.length;
  const age = spelledAge(batch.appliedAt);

  function handleDelete() {
    if (!batch) return;
    undo.mutate(
      { batchId: batch.batchId, namespace: batch.ledgerNamespace },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open={!!batch} onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={{ border: `1px solid ${RED}40` }}>
        <DialogHeader className="items-start gap-3">
          <span
            className="flex shrink-0 items-center justify-center rounded-full"
            style={{ width: 30, height: 30, background: `${RED}1F`, border: `1px solid ${RED}45` }}
          >
            <RotateCcw size={16} style={{ color: RED }} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 3 }}>
            <DialogTitle>Undo this deployment?</DialogTitle>
            <span className="font-mono text-2xs" style={{ color: "var(--fg-tertiary)" }}>
              {meta.label} · {age} ago
            </span>
          </div>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <DialogDescription className="text-xs leading-relaxed">
            This permanently deletes the {count} resources this apply created.
            Resources you changed since will be removed too.
          </DialogDescription>
          <div
            className="flex flex-col"
            style={{ background: "var(--surface-sunken)", borderRadius: 6, border: `1px solid ${BORDER_SUBTLE}`, overflow: "hidden" }}
          >
            {batch.resources.map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between"
                style={{
                  padding: "8px 12px",
                  borderBottom: i === count - 1 ? "none" : `1px solid ${BORDER_SUBTLE}`,
                }}
              >
                <span className="font-mono" style={{ fontSize: 12, color: "var(--fg-primary)" }}>
                  {r.kind}/{r.name}
                </span>
                <span className="font-mono" style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>
                  {r.namespace}
                </span>
              </div>
            ))}
          </div>
          {undo.isError && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {undo.error.message}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={undo.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={undo.isPending}>
            {undo.isPending ? "Deleting…" : `Delete ${count} resources`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
