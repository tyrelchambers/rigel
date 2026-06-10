import { Fragment, useEffect, useMemo, useState } from "react";
import { LoaderCircle, ChevronRight, ChevronDown, MoreHorizontal, ArrowRightLeft } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useForwards } from "@/lib/api";
import type { Service, ServicePort } from "./types";
import type { Pod } from "../pods/types";
import {
  relativeAge,
  typeLabel,
  isExternalName,
  portSummaries,
  externalAddress,
  endpointCount,
  matchesSearch,
  sortServices,
} from "./servicesDisplay";
import { getForwardingServices } from "./portForward";
import { ActiveForwardsList } from "./ActiveForwardsList";
import { PortForwardDialog, type PortForwardTarget } from "./PortForwardDialog";

// ---------------------------------------------------------------------------
// IMPLEMENTED: Port-forward (docs/parity/portforward.md) — "Forward port" row
// action, ACTIVE FORWARDS list, and the running-forward badge.
//
// DEFERRED ACTIONS (docs/parity/services.md §"Row Actions") — still NOT wired:
//   - Edit / Create / Delete service mutations (need ConfirmSheet wiring +
//     server action routes — reuse the pods/nodes ConfirmSheet pattern later).
//   - Ask Claude handoff (needs a service-diagnostics context builder).
//   - View YAML (needs a server YAML endpoint + viewer UI).
// ---------------------------------------------------------------------------

/** Type → badge color class. ExternalName is secondary; the rest are primary. */
function typeBadgeClass(type: string): string {
  return type === "ExternalName"
    ? "bg-muted text-muted-foreground"
    : "bg-primary/10 text-primary";
}

export default function ServicesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [forwardTarget, setForwardTarget] = useState<PortForwardTarget | null>(null);

  // Active port-forwards (polled every 3s) drive the ACTIVE FORWARDS list, the
  // running-forward badge, and the dialog's duplicate-port validation.
  const { data: forwards = [] } = useForwards();

  // Subscribe to the services watch for the active namespace (or all).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("services", ns);
    return () => unsubscribe("services", ns);
  }, [namespaceFilter]);

  const allServices = useMemo(
    () => sortServices(Object.values((resources["services"] ?? {}) as Record<string, Service>)),
    [resources],
  );
  const filtered = useMemo(
    () => allServices.filter((s) => matchesSearch(s, search)),
    [allServices, search],
  );

  // Endpoint count matches pods by label in the same namespace. The store keys
  // pods by name only, so pass the full pod list to the helper.
  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, Pod>),
    [resources],
  );

  const forwardingUids = useMemo(
    () => getForwardingServices(forwards, allServices),
    [forwards, allServices],
  );

  const total = allServices.length;
  const shown = filtered.length;
  const countLabel = search.trim() && shown !== total ? `${shown} / ${total}` : `${total}`;

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Services</h1>
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
          placeholder="Search services…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Error banner */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Active port-forwards (above the table; hidden when none) */}
      <ActiveForwardsList forwards={forwards} />

      {/* Start-a-forward dialog */}
      <PortForwardDialog
        target={forwardTarget}
        activeForwards={forwards}
        onClose={() => setForwardTarget(null)}
      />

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6" />
            <TableHead>Namespace</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Cluster IP</TableHead>
            <TableHead>Ports</TableHead>
            <TableHead>Endpoints</TableHead>
            <TableHead>External Address</TableHead>
            <TableHead>Age</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((svc) => {
            const uid = svc.metadata.uid;
            const isOpen = expanded.has(uid);
            const type = typeLabel(svc);
            const clusterIP = svc.spec?.clusterIP;
            const showClusterIP = !!clusterIP && clusterIP !== "None";
            const summaries = portSummaries(svc.spec?.ports);
            const endpoints = endpointCount(svc, pods);
            const external = externalAddress(svc);
            const isForwarding = forwardingUids.has(uid);
            return (
              <Fragment key={uid}>
                <TableRow>
                  <TableCell className="align-top">
                    <button
                      type="button"
                      onClick={() => toggleExpand(uid)}
                      aria-label={isOpen ? "Collapse" : "Expand"}
                      aria-expanded={isOpen}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {svc.metadata.namespace ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleExpand(uid)}
                        className="font-mono hover:underline"
                      >
                        {svc.metadata.name}
                      </button>
                      {isForwarding && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-1.5 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                          <ArrowRightLeft className="size-3" />
                          Forwarding
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${typeBadgeClass(type)}`}
                    >
                      {type}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground/80">
                    {showClusterIP ? clusterIP : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {summaries.length > 0 ? summaries.join(", ") : "no ports"}
                  </TableCell>
                  <TableCell
                    className={`font-mono ${
                      endpoints === 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    {endpoints === null ? "—" : endpoints}
                  </TableCell>
                  <TableCell
                    className="max-w-[16rem] truncate font-mono text-muted-foreground"
                    title={external ?? undefined}
                  >
                    {external ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {relativeAge(svc.metadata.creationTimestamp)}
                  </TableCell>
                  <TableCell className="align-top">
                    <ServiceActions service={svc} onForward={setForwardTarget} />
                  </TableCell>
                </TableRow>

                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={10} className="bg-muted/30">
                      <ServiceDetail service={svc} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && allServices.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No services found</p>
      )}
      {!isLoading && allServices.length > 0 && filtered.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No services found</p>
      )}
    </div>
  );
}

/** Expanded detail: PORTS, SELECTOR (if any), EXTERNAL (if any). */
function ServiceDetail({ service }: { service: Service }) {
  const ports = service.spec?.ports ?? [];
  const selector = service.spec?.selector ?? {};
  const selectorEntries = Object.entries(selector);
  const external = externalAddress(service);

  return (
    <div className="space-y-3 px-2 py-3">
      {/* PORTS */}
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Ports
        </h3>
        {ports.length === 0 ? (
          <p className="text-xs text-muted-foreground">no ports</p>
        ) : (
          <ul className="space-y-0.5 text-xs font-mono">
            {ports.map((p, i) => {
              const target = p.targetPort != null ? String(p.targetPort) : `${p.port}`;
              const proto = p.protocol ?? "TCP";
              const node = p.nodePort != null ? `, NodePort: ${p.nodePort}` : "";
              const label = p.name ? `${p.name} ` : "";
              return (
                <li key={`${p.port}-${i}`}>
                  {label}({p.port} → {target} / {proto}{node})
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* SELECTOR (only when non-empty) */}
      {selectorEntries.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Selector
          </h3>
          <ul className="space-y-0.5 text-xs font-mono">
            {selectorEntries.map(([k, v]) => (
              <li key={k}>
                {k}={v}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* EXTERNAL (only when present) */}
      {external && (
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            External
          </h3>
          <p className="text-xs font-mono break-all">{external}</p>
        </div>
      )}
    </div>
  );
}

/** Human label + remote port for one "Forward port" menu entry. */
function forwardOption(p: ServicePort): { remotePort: number; label: string } {
  const name = p.name ? `${p.name} ` : "";
  const proto = p.protocol && p.protocol !== "TCP" ? `/${p.protocol}` : "";
  return { remotePort: p.port, label: `Forward port ${name}${p.port}${proto}` };
}

/**
 * Per-row ellipsis menu. The only action today is "Forward port"
 * (docs/parity/portforward.md §"Port-Forward Action in Row Context"):
 *   - ExternalName services → the action is hidden (cannot be port-forwarded).
 *   - No ports → a single disabled "Forward port" item.
 *   - One port → "Forward port <port>".
 *   - Multiple ports → one "Forward port <port>" item per port.
 * Selecting an item opens the PortForwardDialog with that service port as the
 * remote port; kubectl forwards `svc/<name> <local>:<servicePort>`.
 */
function ServiceActions({
  service,
  onForward,
}: {
  service: Service;
  onForward: (target: PortForwardTarget) => void;
}) {
  // ExternalName has no cluster endpoint to forward to → no menu at all.
  if (isExternalName(service)) return null;

  const namespace = service.metadata.namespace ?? "default";
  const ports = service.spec?.ports ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${service.metadata.name}`}
            title="Actions"
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ports.length === 0 ? (
          <DropdownMenuItem disabled>Forward port (no ports)</DropdownMenuItem>
        ) : (
          ports.map((p, i) => {
            const { remotePort, label } = forwardOption(p);
            return (
              <DropdownMenuItem
                key={`${remotePort}-${i}`}
                onClick={() =>
                  onForward({ service: service.metadata.name, namespace, remotePort })
                }
              >
                <ArrowRightLeft className="size-3.5" />
                {label}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
