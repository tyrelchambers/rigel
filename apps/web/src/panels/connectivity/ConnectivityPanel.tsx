import { useEffect, useMemo } from "react";
import {
  Globe,
  Signpost,
  Network,
  Boxes,
  Lock,
  AlertTriangle,
  ArrowRight,
  Split,
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { ListRow } from "@/panels/components/ListRow";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { TagPill } from "@/panels/components/TagPill";
import { PanelHeader } from "@/panels/components/PanelHeader";
import type { StatusBadgeVariant } from "@/panels/components/StatusBadge";
import type { Ingress } from "../ingresses/types";
import type { Service } from "../services/types";
import type { Pod } from "../pods/types";
import type { Flow, Health } from "./types";
import { computeFlows } from "./connectivityDisplay";

// ---------------------------------------------------------------------------
// DEFERRED ACTIONS (docs/parity/connectivity.md §"Deferred Actions"). This is a
// strictly read-only diagnostic map. The following are intentionally NOT
// implemented and must NOT be added without a new feature spec + infra:
//   - onSelectService / onSelectPods are stubs (jump-to-panel navigation is TBD;
//     wiring them requires cross-panel selection state). They no-op safely.
//   - Port-forward UI, View YAML, Ask Claude handoff, forwarding badge.
//   - NO mutations, NO ConfirmSheet, NO kubectl writes, NO new server routes.
// ---------------------------------------------------------------------------

/** Deferred — jump to the Services panel filtered to this service (TBD). */
function onSelectService(_serviceName: string, _namespace: string): void {
  // Intentionally a no-op until cross-panel navigation exists. See spec.
}

/** Deferred — jump to the Pods panel filtered to this flow's pods (TBD). */
function onSelectPods(_flow: Flow): void {
  // Intentionally a no-op until cross-panel navigation exists. See spec.
}

// Health → StatusBadge variant mapping.
const HEALTH_VARIANT: Record<Health, StatusBadgeVariant> = {
  ok: "healthy",
  warn: "pending",
  broken: "error",
};

// Health → dot color for the legend.
const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-green-500",
  warn: "bg-yellow-500",
  broken: "bg-red-500",
};

// Health → text color for issue lines.
const HEALTH_TEXT: Record<Health, string> = {
  ok: "text-green-600 dark:text-green-400",
  warn: "text-yellow-600 dark:text-yellow-400",
  broken: "text-red-600 dark:text-red-400",
};

export default function ConnectivityPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  // Subscribe to all three watches for the active namespace (or all). Clean up
  // on unmount / namespace change.
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("ingresses", ns);
    subscribe("services", ns);
    subscribe("pods", ns);
    return () => {
      unsubscribe("ingresses", ns);
      unsubscribe("services", ns);
      unsubscribe("pods", ns);
    };
  }, [namespaceFilter]);

  const ingresses = useMemo(
    () => Object.values((resources["ingresses"] ?? {}) as Record<string, Ingress>),
    [resources],
  );
  const services = useMemo(
    () => Object.values((resources["services"] ?? {}) as Record<string, Service>),
    [resources],
  );
  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, Pod>),
    [resources],
  );

  const flows = useMemo(
    () => computeFlows(ingresses, services, pods),
    [ingresses, services, pods],
  );

  const external = flows.filter((f) => f.isExternal);
  const internal = flows.filter((f) => !f.isExternal);

  // First snapshot hasn't arrived yet (no flows + loading): show a placeholder.
  const firstLoad = isLoading && flows.length === 0;

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Connectivity" subtitle="Ingress → Service → Pods" loading={isLoading}>
        <Legend />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
        {/* Error banner — keep last flows visible (stale OK). */}
        {error && (
          <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}

        {firstLoad && (
          <p className="px-4 py-4 text-sm text-muted-foreground">Loading connectivity…</p>
        )}

        {!firstLoad && flows.length === 0 && <EmptyState />}

        {flows.length > 0 && (
          <div className="flex flex-col gap-4 px-3 py-2">
            {external.length > 0 && (
              <Section title="External" count={external.length}>
                {external.map((f) => (
                  <FlowRow key={f.id} flow={f} />
                ))}
              </Section>
            )}
            {internal.length > 0 && (
              <Section title="Internal" count={internal.length}>
                {internal.map((f) => (
                  <FlowRow key={f.id} flow={f} />
                ))}
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className={`size-2 rounded-full ${HEALTH_DOT.ok}`} /> Reachable
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`size-2 rounded-full ${HEALTH_DOT.warn}`} /> Degraded
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`size-2 rounded-full ${HEALTH_DOT.broken}`} /> Broken
      </span>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1">
      <h2
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: "#6B6B73" }}
      >
        {title}{" "}
        <span className="font-mono">({count})</span>
      </h2>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

function Chip({
  icon,
  children,
  style,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-sm" style={style}>
      {icon}
      <span className="font-mono">{children}</span>
    </span>
  );
}

function Arrow() {
  return <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />;
}

function FlowRow({ flow }: { flow: Flow }) {
  const podsDisabled = flow.totalPods === 0;
  const tintClass = HEALTH_TEXT[flow.health];
  const healthColor =
    flow.health === "ok" ? "#10B981" : flow.health === "warn" ? "#F59E0B" : "#EF4444";

  return (
    <ListRow
      rowKey={flow.id}
      isOpen={false}
      onToggle={() => {}}
    >
      {/* Flex-col container so the issues line stacks below the main chain */}
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        {/* Main chain */}
        <div className="flex flex-wrap items-center gap-1.5">
          {flow.isExternal ? (
            <>
              <Chip
                icon={<Globe className="size-3.5 text-muted-foreground" />}
                style={{ color: "#A1A1AA" }}
              >
                {flow.hosts.length > 0 ? flow.hosts.join(", ") : "(no host)"}
              </Chip>
              <Arrow />
              <Chip
                icon={<Signpost className="size-3.5 text-muted-foreground" />}
                style={{ color: "#A1A1AA" }}
              >
                {flow.ingressNames.join(", ")}
              </Chip>
              <Arrow />
            </>
          ) : (
            <>
              <Chip
                icon={<Lock className="size-3.5 text-muted-foreground" />}
                style={{ color: "#6B6B73" }}
              >
                cluster
              </Chip>
              <Arrow />
            </>
          )}

          {/* Service identity — TagPill when exists, error-colored when missing */}
          <button
            type="button"
            onClick={() => onSelectService(flow.serviceName, flow.namespace)}
            className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {flow.serviceExists ? (
              <TagPill label={`svc/${flow.serviceName}`} title={flow.serviceName} />
            ) : (
              <Chip
                icon={<Network className="size-3.5" style={{ color: "#EF4444" }} />}
                style={{ color: "#EF4444" }}
              >
                svc/{flow.serviceName}
              </Chip>
            )}
          </button>

          <Arrow />

          {/* Pod count chip */}
          <button
            type="button"
            disabled={podsDisabled}
            onClick={() => onSelectPods(flow)}
            className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          >
            <Chip
              icon={<Boxes className="size-3.5" style={{ color: healthColor }} />}
              style={{ color: healthColor }}
            >
              {flow.serviceExists ? `${flow.readyPods}/${flow.totalPods}` : "no service"}
            </Chip>
          </button>

          {/* Spacer */}
          <span className="flex-1" />

          {/* Health badge */}
          <StatusBadge
            label={flow.health === "ok" ? "ok" : flow.health === "warn" ? "degraded" : "broken"}
            variant={HEALTH_VARIANT[flow.health]}
          />

          {/* Namespace */}
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 10,
              color: "#6B6B73",
              whiteSpace: "nowrap",
            }}
          >
            {flow.namespace}
          </span>
        </div>

        {/* Issues line — always visible when present */}
        {flow.issues.length > 0 && (
          <div className={`flex items-center gap-1.5 text-xs ${tintClass}`}>
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            <span className="font-mono">{flow.issues.join(" · ")}</span>
          </div>
        )}
      </div>
    </ListRow>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <Split className="size-10 text-muted-foreground/50" aria-hidden />
      <p className="text-sm font-medium text-muted-foreground">No services to map yet.</p>
      <p className="max-w-sm text-xs text-muted-foreground/70">
        Connectivity traces ingress → service → pods so you can spot unreachable apps.
      </p>
    </div>
  );
}
