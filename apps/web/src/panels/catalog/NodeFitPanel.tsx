import { CheckCircle2, Circle, CircleSlash } from "lucide-react";
import type { CatalogApp } from "@helmsman/catalog";
import {
  formatBytesValue,
  formatCoresValue,
  isReady,
  parseBytes,
  parseCpuCores,
} from "@/panels/nodes/nodeDisplay";
import type { FitResult, NodeFitEntry } from "./nodeFit";

// Theme constants — mirror the Swift Theme tokens the sheet uses.
const ACCENT = "#A855F7";
const ACCENT_DIM = "rgba(168,85,247,0.15)";
const GREEN = "#10B981"; // Theme.Status.running
const AMBER = "#F59E0B"; // Theme.Status.pending
const RED = "#EF4444"; // Theme.Status.failed
const FG_PRIMARY = "#FFFFFF";
const FG_SECONDARY = "#A1A1AA";
const FG_TERTIARY = "#6B6B73";
const BORDER = "#2A2A2A";
const SURFACE_ELEVATED = "#141417";
const SURFACE_SUNKEN = "#0A0A0A";

/**
 * NODE FIT panel — port of `CatalogDetailSheet.swift`'s `rightColumn` /
 * `fitSummary` / `AnyNodeRow` / `NodeFitCard` / `ResourceBar`. Lets the user
 * pin the install to a specific node (or "Any" to let the recommendation
 * stand). Purely presentational; fit math comes from `nodeFit`.
 */
export function NodeFitPanel({
  app,
  fit,
  selectedNode,
  onSelectNode,
}: {
  app: CatalogApp;
  fit: FitResult;
  selectedNode: string | null;
  onSelectNode: (node: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {/* Header + summary dot */}
      <div className="flex items-center">
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: 0.5,
            color: FG_TERTIARY,
          }}
        >
          NODE FIT
        </span>
        <span className="flex-1" />
        <FitSummary fit={fit} />
      </div>

      {fit.perNode.length === 0 ? (
        <p style={{ fontSize: 11, color: FG_TERTIARY }}>
          No nodes visible — is the cluster reachable?
        </p>
      ) : (
        <>
          <p style={{ fontSize: 11, color: FG_SECONDARY }}>
            Pick a node to pin this app to, or leave it on Any to let the
            recommendation stand.
          </p>
          <AnyNodeRow
            recommendedName={fit.recommended?.node.metadata.name ?? null}
            isSelected={selectedNode === null}
            onSelect={() => onSelectNode(null)}
          />
          {fit.perNode.map((nf) => (
            <NodeFitCard
              key={nf.node.metadata.uid || nf.node.metadata.name}
              fit={nf}
              isRecommended={nf === fit.recommended}
              isSelected={selectedNode === nf.node.metadata.name}
              app={app}
              onSelect={
                nf.eligible ? () => onSelectNode(nf.node.metadata.name) : null
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

/** Cluster-wide fit indicator: green="fits", yellow="tight", red="no node fits". */
function FitSummary({ fit }: { fit: FitResult }) {
  const color = fit.dot === "green" ? GREEN : fit.dot === "yellow" ? AMBER : RED;
  const label =
    fit.dot === "green" ? "fits" : fit.dot === "yellow" ? "tight" : "no node fits";
  return (
    <span className="flex items-center" style={{ gap: 4 }}>
      <span
        style={{ width: 6, height: 6, borderRadius: "50%", background: color }}
      />
      <span
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 10,
          fontWeight: 500,
          color,
        }}
      >
        {label}
      </span>
    </span>
  );
}

/** "Any node" radio row — picking it clears the node pin. */
function AnyNodeRow({
  recommendedName,
  isSelected,
  onSelect,
}: {
  recommendedName: string | null;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center text-left"
      style={{
        gap: 6,
        padding: 10,
        background: SURFACE_ELEVATED,
        border: `${isSelected ? 1.5 : 1}px solid ${isSelected ? ACCENT : BORDER}`,
        borderRadius: 6,
      }}
    >
      {isSelected ? (
        <CheckCircle2 size={11} style={{ color: ACCENT, flexShrink: 0 }} aria-hidden />
      ) : (
        <Circle size={11} style={{ color: FG_TERTIARY, flexShrink: 0 }} aria-hidden />
      )}
      <span className="flex flex-col" style={{ gap: 1 }}>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            fontWeight: 600,
            color: FG_PRIMARY,
          }}
        >
          Any node
        </span>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 9,
            color: FG_TERTIARY,
          }}
        >
          {recommendedName ? `recommended: ${recommendedName}` : "no node currently fits"}
        </span>
      </span>
    </button>
  );
}

/** Ineligibility reason in the same precedence Swift uses. null when eligible. */
function ineligibleReason(fit: NodeFitEntry): string | null {
  if (!isReady(fit.node)) return "not ready";
  if (fit.cordoned) return "cordoned";
  if (fit.tainted) return "tainted (NoSchedule)";
  if (!fit.canHost) return "insufficient capacity";
  return null;
}

/**
 * Per-node card: selection radio, name, recommended badge OR ineligibility
 * reason, then CPU/Mem/Disk ResourceBars. Dimmed + non-interactive (slash
 * icon) when `onSelect` is null.
 */
function NodeFitCard({
  fit,
  isRecommended,
  isSelected,
  app,
  onSelect,
}: {
  fit: NodeFitEntry;
  isRecommended: boolean;
  isSelected: boolean;
  app: CatalogApp;
  /** null when the node can't host the app — renders dimmed + non-interactive. */
  onSelect: (() => void) | null;
}) {
  const reason = ineligibleReason(fit);
  const borderColor = isSelected
    ? ACCENT
    : isRecommended
      ? "rgba(168,85,247,0.5)"
      : BORDER;

  const appDisk = (app.requirements.storageGiB ?? 0) * 1024 * 1024 * 1024;

  const card = (
    <div
      className="flex flex-col"
      style={{
        gap: 6,
        padding: 10,
        background: SURFACE_ELEVATED,
        border: `${isSelected ? 1.5 : 1}px solid ${borderColor}`,
        borderRadius: 6,
      }}
    >
      <div className="flex items-center" style={{ gap: 6 }}>
        {onSelect == null ? (
          <CircleSlash size={11} style={{ color: FG_TERTIARY, flexShrink: 0 }} aria-hidden />
        ) : isSelected ? (
          <CheckCircle2 size={11} style={{ color: ACCENT, flexShrink: 0 }} aria-hidden />
        ) : (
          <Circle size={11} style={{ color: FG_TERTIARY, flexShrink: 0 }} aria-hidden />
        )}
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            fontWeight: 600,
            color: FG_PRIMARY,
          }}
        >
          {fit.node.metadata.name}
        </span>
        <span className="flex-1" />
        {isRecommended ? (
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 9,
              fontWeight: 600,
              color: ACCENT,
              background: ACCENT_DIM,
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            recommended
          </span>
        ) : reason ? (
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 9,
              color: FG_TERTIARY,
            }}
          >
            {reason}
          </span>
        ) : null}
      </div>

      <ResourceBar
        label="CPU"
        used={fit.allocatableCPU - fit.freeCPU}
        free={fit.freeCPU}
        requested={parseCpuCores(app.requirements.cpuRequest)}
        format={formatCoresValue}
      />
      <ResourceBar
        label="Mem"
        used={fit.allocatableMemoryBytes - fit.freeMemoryBytes}
        free={fit.freeMemoryBytes}
        requested={parseBytes(app.requirements.memoryRequest)}
        format={formatBytesValue}
      />
      {fit.allocatableDiskBytes > 0 && (
        <ResourceBar
          label="Disk"
          used={Math.max(0, fit.allocatableDiskBytes - fit.freeDiskBytes)}
          free={fit.freeDiskBytes}
          requested={appDisk}
          format={formatBytesValue}
        />
      )}
    </div>
  );

  if (onSelect == null) {
    return <div style={{ opacity: 0.55 }}>{card}</div>;
  }
  return (
    <button type="button" onClick={onSelect} className="block w-full text-left">
      {card}
    </button>
  );
}

/**
 * A used/free/requested capacity bar. used = dark segment, free = light track,
 * requested overlay (green when it fits, red when it doesn't) starts at the
 * right edge of existing usage. Bar math is identical to Swift's ResourceBar.
 */
function ResourceBar({
  label,
  used,
  free,
  requested,
  format,
}: {
  label: string;
  used: number;
  free: number;
  requested: number;
  format: (v: number) => string;
}) {
  const total = used + free;
  const usedFrac = total > 0 ? Math.min(1, used / total) : 0;
  const requestedFrac = total > 0 ? Math.min(1, requested / total) : 0;
  const requestFits = requested <= free;

  return (
    <div className="flex flex-col" style={{ gap: 3 }}>
      <div className="flex items-center">
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 9,
            fontWeight: 600,
            color: FG_TERTIARY,
            width: 30,
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 9,
            color: FG_SECONDARY,
          }}
        >
          {format(free)} free / {format(total)}
        </span>
        <span className="flex-1" />
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 9,
            color: requestFits ? GREEN : RED,
          }}
        >
          needs {format(requested)}
        </span>
      </div>
      {/* Stacked bar: sunken track, dark used segment, requested overlay. */}
      <div
        style={{
          position: "relative",
          height: 6,
          borderRadius: 2,
          background: SURFACE_SUNKEN,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${usedFrac * 100}%`,
            background: "rgba(107,107,115,0.6)",
            borderRadius: 2,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${usedFrac * 100}%`,
            width: `${requestedFrac * 100}%`,
            background: requestFits ? "rgba(168,85,247,0.7)" : "rgba(239,68,68,0.7)",
            borderRadius: 2,
          }}
        />
      </div>
    </div>
  );
}
