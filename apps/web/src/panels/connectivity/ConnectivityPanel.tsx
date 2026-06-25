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
import { useNavigate } from "react-router";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { goToResource } from "@/lib/resourceNav";
import { ListRow } from "@/panels/components/ListRow";
import { ContextMenuItem } from "@/components/ui/context-menu";
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
// Navigation uses goToResource to jump to the Services or Pods panel and focus
// the selected row. Port-forward UI, View YAML, Ask Claude handoff, and
// forwarding badge remain deferred. NO mutations, NO kubectl writes.
// ---------------------------------------------------------------------------

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
        style={{ color: "var(--fg-tertiary)" }}
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
  const navigate = useNavigate();
  const podsDisabled = flow.totalPods === 0;
  const tintClass = HEALTH_TEXT[flow.health];
  const healthColor =
    flow.health === "ok" ? "var(--status-running)" : flow.health === "warn" ? "var(--status-pending)" : "var(--status-failed)";

  function handleSelectService() {
    goToResource(navigate, {
      kind: "services",
      name: flow.serviceName,
      namespace: flow.namespace,
      key: `${flow.namespace}/${flow.serviceName}`,
      status: "ok",
    });
  }

  function handleSelectPods() {
    if (podsDisabled) return;
    // Navigate to pods panel; focus the first pod if there is one.
    const firstName = flow.podNames[0];
    if (!firstName) return;
    goToResource(navigate, {
      kind: "pods",
      name: firstName,
      namespace: flow.namespace,
      key: `${flow.namespace}/${firstName}`,
      status: "ok",
    });
  }

  const rowMenu = (
    <>
      <ContextMenuItem onClick={handleSelectService}>View service</ContextMenuItem>
      <ContextMenuItem disabled={podsDisabled} onClick={handleSelectPods}>View pods</ContextMenuItem>
    </>
  );

  return (
    <ListRow
      rowKey={flow.id}
      isOpen={false}
      onToggle={() => {}}
      contextMenu={rowMenu}
    >
      {/* Flex-col container so the issues line stacks below the main chain */}
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        {/* Main chain */}
        <div className="flex flex-wrap items-center gap-1.5">
          {flow.isExternal ? (
            <>
              <Chip
                icon={<Globe className="size-3.5 text-muted-foreground" />}
                style={{ color: "var(--fg-secondary)" }}
              >
                {flow.hosts.length > 0 ? flow.hosts.join(", ") : "(no host)"}
              </Chip>
              <Arrow />
              <Chip
                icon={<Signpost className="size-3.5 text-muted-foreground" />}
                style={{ color: "var(--fg-secondary)" }}
              >
                {flow.ingressNames.join(", ")}
              </Chip>
              <Arrow />
            </>
          ) : (
            <>
              <Chip
                icon={<Lock className="size-3.5 text-muted-foreground" />}
                style={{ color: "var(--fg-tertiary)" }}
              >
                cluster
              </Chip>
              <Arrow />
            </>
          )}

          {/* Service identity — TagPill when exists, error-colored when missing */}
          <button
            type="button"
            onClick={handleSelectService}
            className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {flow.serviceExists ? (
              <TagPill label={`svc/${flow.serviceName}`} title={flow.serviceName} />
            ) : (
              <Chip
                icon={<Network className="size-3.5" style={{ color: "var(--status-failed)" }} />}
                style={{ color: "var(--status-failed)" }}
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
            onClick={handleSelectPods}
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
              color: "var(--fg-tertiary)",
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
