import { Globe, Lock, Network, Signpost } from "lucide-react";
import { useNavigate } from "react-router";
import { goToResource } from "@/lib/resourceNav";
import { MetaCard, SectionLabel } from "@/panels/components/MetaCard";
import { healthColor } from "./connectivityDisplay";
import type { Flow, FlowPod } from "./types";

// ---------------------------------------------------------------------------
// Expanded row body for a connectivity Flow. Renders inside the shared ListRow
// expanded wrapper (which supplies the surrounding padding + background).
// Read-only: every element either displays derived flow data or navigates to
// another panel. NO mutations. Follows the "expanded row (improved)" pattern
// (MetaCard/SectionLabel), mirroring ConfigMaps/Services.
// ---------------------------------------------------------------------------

// A pod's status dot color: green when ready, else pending/failed by phase.
function podDotColor(p: FlowPod): string {
  if (p.ready) return "var(--status-running)";
  return p.phase === "Failed" ? "var(--status-failed)" : "var(--status-pending)";
}

export function ConnectivityDetail({ flow }: { flow: Flow }) {
  const navigate = useNavigate();

  function goPod(name: string) {
    goToResource(navigate, {
      kind: "pods",
      name,
      namespace: flow.namespace,
      key: `${flow.namespace}/${name}`,
      status: "ok",
    });
  }

  function goIngress(name: string) {
    goToResource(navigate, {
      kind: "ingresses",
      name,
      namespace: flow.namespace,
      key: `${flow.namespace}/${name}`,
      status: "ok",
    });
  }

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Meta strip: ROUTE / SERVICE / ENDPOINTS */}
      <div className="flex gap-3">
        <MetaCard label="ROUTE">
          <div className="flex items-center gap-[7px]">
            {flow.isExternal ? (
              <Globe className="size-[13px] text-[var(--fg-tertiary)]" />
            ) : (
              <Lock className="size-[13px] text-[var(--fg-tertiary)]" />
            )}
            <span className="font-mono text-xs text-[var(--fg-secondary)]">
              {flow.isExternal
                ? flow.hosts.length > 0
                  ? flow.hosts.join(", ")
                  : "(no host)"
                : "cluster (internal)"}
            </span>
          </div>
        </MetaCard>

        <MetaCard label="SERVICE">
          <div className="flex items-center gap-[7px]">
            <Network
              className="size-[13px]"
              style={{ color: flow.serviceExists ? "var(--fg-tertiary)" : "var(--status-failed)" }}
            />
            <span
              className="font-mono text-xs"
              style={{ color: flow.serviceExists ? "var(--fg-secondary)" : "var(--status-failed)" }}
            >
              {flow.serviceExists ? `svc/${flow.serviceName} · ${flow.serviceType}` : "missing"}
            </span>
          </div>
        </MetaCard>

        <MetaCard label="ENDPOINTS">
          <div className="flex items-baseline gap-1.5">
            <span
              className="text-lg font-bold leading-none"
              style={{ color: healthColor(flow.health) }}
            >
              {flow.readyPods}/{flow.totalPods}
            </span>
            <span className="text-xs text-[var(--fg-tertiary)]">ready</span>
          </div>
        </MetaCard>
      </div>

      {/* Ingress routes — external flows only */}
      {flow.isExternal && flow.ingressNames.length > 0 && (
        <div className="flex flex-col gap-[9px]">
          <SectionLabel>ROUTES</SectionLabel>
          <div className="flex flex-col gap-1.5">
            {flow.ingressNames.map((ing) => (
              <button
                key={ing}
                type="button"
                onClick={() => goIngress(ing)}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[13px] py-[10px] text-left transition-colors hover:bg-[var(--surface-elevated)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Signpost className="size-3.5 text-[var(--fg-tertiary)]" aria-hidden />
                <span className="font-mono text-xs text-[var(--fg-secondary)]">{ing}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Backing pods */}
      <div className="flex flex-col gap-[9px]">
        <SectionLabel>{`PODS · ${flow.totalPods}`}</SectionLabel>
        {flow.pods.length === 0 ? (
          <p className="text-xs text-[var(--fg-tertiary)]">
            {flow.serviceExists ? "No pods match this service" : "Service does not exist"}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {flow.pods.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => goPod(p.name)}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[13px] py-[10px] text-left transition-colors hover:bg-[var(--surface-elevated)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  className="size-[7px] shrink-0 rounded-full"
                  style={{ background: podDotColor(p) }}
                  aria-hidden
                />
                <span className="font-mono text-xs text-[var(--fg-secondary)]">{p.name}</span>
                <span className="flex-1" />
                <span className="font-mono text-2xs text-[var(--fg-tertiary)]">{p.phase}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Issues */}
      {flow.issues.length > 0 && (
        <div className="flex flex-col gap-[9px]">
          <SectionLabel>ISSUES</SectionLabel>
          <p
            className="font-mono text-xs"
            style={{ color: healthColor(flow.health) }}
          >
            {flow.issues.join(" · ")}
          </p>
        </div>
      )}
    </div>
  );
}
