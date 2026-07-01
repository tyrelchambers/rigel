import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { viewYaml } from "@/store/yamlViewer";
import { ListRow } from "@/panels/components/ListRow";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { useFocusRow } from "@/panels/components/useFocusRow";
import { useForwards } from "@/lib/api";
import type { Service } from "./types";
import type { Pod } from "../pods/types";
import {
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
import { PanelHeader } from "@/panels/components/PanelHeader";
import { ServiceDetail } from "./ServiceDetail";

// ---------------------------------------------------------------------------
// IMPLEMENTED: Port-forward (docs/parity/portforward.md).
// Errors/Logs/Explain handoffs use handoffToChat.
// Read-only panel — no destructive mutations. Port-forward remains in row strip.
// ---------------------------------------------------------------------------

export default function ServicesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [forwardTarget, setForwardTarget] = useState<PortForwardTarget | null>(null);

  // Active port-forwards (polled every 3s)
  const { data: forwards = [] } = useForwards();

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

  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, Pod>),
    [resources],
  );

  const forwardingUids = useMemo(
    () => getForwardingServices(forwards, allServices),
    [forwards, allServices],
  );

  const shown = filtered.length;

  useFocusRow("service", allServices, (svc) => svc.metadata.uid, (k) => setExpanded((prev) => new Set(prev).add(k)));

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function askClaude(svc: Service, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(buildHandoffPrompt("service", svc.metadata.name, svc.metadata.namespace, topic));
  }

  function openForwardDialog(svc: Service) {
    const ports = svc.spec?.ports ?? [];
    if (ports.length === 0) return;
    setForwardTarget({
      service: svc.metadata.name,
      namespace: svc.metadata.namespace ?? "default",
      remotePort: ports[0].port,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Services"
        subtitle="ClusterIP · NodePort · LoadBalancer"
        count={shown}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search services…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
        {/* Error banner */}
        {error && (
          <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}

        {/* Active port-forwards (hidden when none) */}
        <div className="px-3 pt-2">
          <ActiveForwardsList forwards={forwards} />
        </div>

        {/* Row list */}
        <div className="flex flex-col gap-0.5 px-3 py-2">
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
          const notExternalName = !isExternalName(svc);
          const canForward = notExternalName && (svc.spec?.ports ?? []).length > 0;

          const rowMenu = (
            <>
              <ContextMenuItem onClick={() => askClaude(svc, "Errors")}>Ask Claude: Errors</ContextMenuItem>
              <ContextMenuItem onClick={() => askClaude(svc, "Logs")}>Ask Claude: Logs</ContextMenuItem>
              <ContextMenuItem onClick={() => askClaude(svc, "Explain")}>Ask Claude: Explain</ContextMenuItem>
              {canForward && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => openForwardDialog(svc)}>Forward…</ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => viewYaml("service", svc.metadata.name, svc.metadata.namespace)}>View YAML…</ContextMenuItem>
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
              expandedContent={<ServiceDetail service={svc} />}
            >
              {/* Name */}
              <button
                type="button"
                onClick={() => toggleExpand(uid)}
                className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
              >
                {svc.metadata.name}
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
                {svc.metadata.namespace ?? "—"}
              </span>

              {/* Type — purple TagPill */}
              <TagPill label={type} />

              {/* Cluster IP — dim */}
              {showClusterIP && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-secondary)",
                    whiteSpace: "nowrap",
                    flexShrink: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                  }}
                >
                  {clusterIP}
                </span>
              )}

              {/* Ports — dim */}
              {summaries.length > 0 && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-tertiary)",
                    whiteSpace: "nowrap",
                    flexShrink: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                  }}
                  title={summaries.join(", ")}
                >
                  {summaries.join(", ")}
                </span>
              )}

              {/* Spacer */}
              <span className="flex-1" />

              {/* Forwarding badge */}
              {isForwarding && (
                <span
                  className="inline-flex items-center gap-1 shrink-0"
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    fontWeight: 500,
                    color: "var(--status-running)",
                    background: "rgba(16,185,129,0.12)",
                    padding: "1px 5px",
                    borderRadius: 4,
                    whiteSpace: "nowrap",
                  }}
                >
                  <ArrowRightLeft className="size-2.5" />
                  Forwarding
                </span>
              )}

              {/* Endpoint count badge — red if 0 */}
              {endpoints !== null && (
                <StatusBadge
                  label={`${endpoints} ep`}
                  variant={endpoints === 0 ? "error" : "neutral"}
                  title={`${endpoints} endpoint${endpoints !== 1 ? "s" : ""}`}
                />
              )}

              {/* External address — dim */}
              {external && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-secondary)",
                    whiteSpace: "nowrap",
                    flexShrink: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                    maxWidth: "12rem",
                  }}
                  title={external}
                >
                  {external}
                </span>
              )}
            </ListRow>
          );
        })}
      </div>

        {/* Empty / filtered-to-zero states */}
        {!isLoading && allServices.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No services found</p>
        )}
        {!isLoading && allServices.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No services match search</p>
        )}
      </div>

      {/* Start-a-forward dialog */}
      <PortForwardDialog
        target={forwardTarget}
        activeForwards={forwards}
        onClose={() => setForwardTarget(null)}
      />
    </div>
  );
}
