import type { ReactNode } from "react";
import { ArrowRight, Copy, Check, Calendar } from "lucide-react";
import { RelatedResources } from "@/panels/components/RelatedResources";
import { useCopyToClipboard } from "@/lib/useCopyToClipboard";
import { humanAge } from "./servicesDisplay";
import type { Service } from "./types";

// ---------------------------------------------------------------------------
// Expanded row body — Pencil frame x2MuTZ ("Services — expanded row (improved)").
// Renders inside the shared ListRow expanded wrapper, which already provides
// the surrounding padding + background, so this is just the section stack.
// ---------------------------------------------------------------------------

export function ServiceDetail({ service }: { service: Service }) {
  const ports = service.spec?.ports ?? [];
  const clusterIP = service.spec?.clusterIP;
  const selectorEntries = Object.entries(service.spec?.selector ?? {});

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Meta row: PORTS / CLUSTER IP / AGE */}
      <div className="flex gap-3">
        <MetaCard label="PORTS">
          {ports.length === 0 ? (
            <span className="font-mono text-xs text-[var(--fg-tertiary)]">—</span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {ports.map((p, i) => {
                const head = p.nodePort != null ? `${p.port}:${p.nodePort}` : String(p.port);
                const accent = p.name || (p.targetPort != null && String(p.targetPort) !== String(p.port) ? String(p.targetPort) : "");
                return (
                  <div
                    key={`${p.port}-${i}`}
                    className="inline-flex items-center gap-[7px] rounded-sm bg-white/[0.05] px-2.5 py-[5px]"
                  >
                    <span className="font-mono text-[13px] font-semibold text-foreground">{head}</span>
                    {accent && (
                      <>
                        <ArrowRight className="size-3 text-[var(--fg-tertiary)]" />
                        <span className="font-mono text-[13px] text-[var(--accent-primary)]">
                          {accent}
                        </span>
                      </>
                    )}
                    <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">
                      {p.protocol ?? "TCP"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </MetaCard>

        <MetaCard label="CLUSTER IP">
          <ClusterIpValue clusterIP={clusterIP} />
        </MetaCard>

        <MetaCard label="AGE">
          <div className="flex items-center gap-[7px]">
            <Calendar className="size-[13px] text-[var(--fg-tertiary)]" />
            <span className="text-[14px] text-[var(--fg-secondary)]">
              {humanAge(service.metadata.creationTimestamp)}
            </span>
          </div>
        </MetaCard>
      </div>

      {/* Selector */}
      {selectorEntries.length > 0 && (
        <div className="flex flex-col gap-[9px]">
          <SectionLabel>SELECTOR</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {selectorEntries.map(([k, v]) => (
              <div
                key={k}
                className="inline-flex items-center rounded-sm border bg-[var(--surface-elevated)] border-[var(--border-subtle)] px-[11px] py-1.5"
              >
                <span className="font-mono text-[12.5px] text-[var(--fg-tertiary)]">{k}=</span>
                <span className="font-mono text-[12.5px] font-medium text-foreground">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Related resources */}
      <RelatedResources sourceKind="service" source={service} />
    </div>
  );
}

function ClusterIpValue({ clusterIP }: { clusterIP: string | undefined }) {
  const { copied, copy } = useCopyToClipboard();
  const hasIp = !!clusterIP && clusterIP !== "None";

  return (
    <div className="flex items-center gap-[9px]">
      <span className="font-mono text-[14px] font-medium text-foreground">{clusterIP || "—"}</span>
      {hasIp && (
        <button
          type="button"
          onClick={() => copy(clusterIP!)}
          aria-label="Copy cluster IP"
          className="text-[var(--fg-tertiary)] hover:text-foreground"
        >
          {copied ? (
            <Check className="size-[13px] text-[var(--status-running)]" />
          ) : (
            <Copy className="size-[13px]" />
          )}
        </button>
      )}
    </div>
  );
}

function MetaCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col gap-[9px] rounded-md border px-[15px] py-[13px] bg-[var(--surface-elevated)] border-[var(--border-subtle)]">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--fg-tertiary)]">
      {children}
    </span>
  );
}
