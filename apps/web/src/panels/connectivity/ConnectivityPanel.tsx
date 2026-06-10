import { useEffect, useMemo } from "react";
import {
  LoaderCircle,
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

// Health → Tailwind tint classes (text / dot / left bar background).
const HEALTH_TEXT: Record<Health, string> = {
  ok: "text-green-600 dark:text-green-400",
  warn: "text-yellow-600 dark:text-yellow-400",
  broken: "text-red-600 dark:text-red-400",
};
const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-green-500",
  warn: "bg-yellow-500",
  broken: "bg-red-500",
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
    <div className="space-y-4">
      {/* Header: title + legend */}
      <div className="flex items-center gap-3 border-b pb-3">
        <h1 className="text-lg font-semibold">Connectivity</h1>
        {isLoading && (
          <LoaderCircle
            className="size-4 animate-spin text-muted-foreground"
            aria-label="loading"
          />
        )}
        <Legend />
      </div>

      {/* Error banner — keep last flows visible (stale OK). */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {firstLoad && (
        <p className="px-2 py-4 text-sm text-muted-foreground">Loading connectivity…</p>
      )}

      {!firstLoad && flows.length === 0 && <EmptyState />}

      {flows.length > 0 && (
        <div className="space-y-6">
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
  );
}

function Legend() {
  return (
    <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
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
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} <span className="font-mono">({count})</span>
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Chip({
  icon,
  children,
  className = "",
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 text-sm ${className}`}>
      {icon}
      <span className="font-mono">{children}</span>
    </span>
  );
}

function Arrow() {
  return <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />;
}

function FlowRow({ flow }: { flow: Flow }) {
  const tint = HEALTH_TEXT[flow.health];
  const podsDisabled = flow.totalPods === 0;

  return (
    <div className="relative overflow-hidden rounded-sm border bg-card">
      {/* Left 3px health color bar. */}
      <span
        className={`absolute inset-y-0 left-0 w-[3px] ${HEALTH_DOT[flow.health]}`}
        aria-hidden
      />
      <div className="space-y-1 py-2 pl-4 pr-3">
        {/* Main chain. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {flow.isExternal ? (
            <>
              <Chip icon={<Globe className="size-3.5 text-muted-foreground" />}>
                {flow.hosts.length > 0 ? flow.hosts.join(", ") : "(no host)"}
              </Chip>
              <Arrow />
              <Chip icon={<Signpost className="size-3.5 text-muted-foreground" />}>
                {flow.ingressNames.join(", ")}
              </Chip>
              <Arrow />
            </>
          ) : (
            <>
              <Chip
                icon={<Lock className="size-3.5 text-muted-foreground" />}
                className="text-muted-foreground"
              >
                cluster
              </Chip>
              <Arrow />
            </>
          )}

          {/* Service chip (button). primary if it exists, red if missing. */}
          <button
            type="button"
            onClick={() => onSelectService(flow.serviceName, flow.namespace)}
            className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Chip
              icon={<Network className="size-3.5" />}
              className={flow.serviceExists ? "text-foreground" : HEALTH_TEXT.broken}
            >
              svc/{flow.serviceName}
            </Chip>
          </button>

          <Arrow />

          {/* Pods chip (button). Disabled when there are no pods. */}
          <button
            type="button"
            disabled={podsDisabled}
            onClick={() => onSelectPods(flow)}
            className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:no-underline disabled:hover:no-underline"
          >
            <Chip icon={<Boxes className="size-3.5" />} className={tint}>
              {flow.serviceExists ? `${flow.readyPods}/${flow.totalPods}` : "no service"}
            </Chip>
          </button>

          {/* Spacer + right-aligned namespace label. */}
          <span className="ml-auto pl-3 font-mono text-xs text-muted-foreground/70">
            {flow.namespace}
          </span>
        </div>

        {/* Issues line. */}
        {flow.issues.length > 0 && (
          <div className={`flex items-center gap-1.5 pl-5 text-xs ${tint}`}>
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            <span className="font-mono">{flow.issues.join(" · ")}</span>
          </div>
        )}
      </div>
    </div>
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
