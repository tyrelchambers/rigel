import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ListRow } from "@/panels/components/ListRow";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { viewYaml } from "@/store/yamlViewer";
import type { ActionBlock } from "@/lib/api";
import { fetchCertManagerPlugin } from "@/lib/api";
import {
  History,
  CircleCheck,
  Loader,
  CircleX,
  Globe,
  Shield,
  Lock,
  Calendar,
  RefreshCw,
  Trash2,
  Copy,
  X,
} from "lucide-react";
import type {
  Certificate,
  CertificateRequest,
  Order,
  Challenge,
  CertView,
  OrderNode,
  ChallengeNode,
} from "./types";
import {
  expiryLabel,
  buildCertViews,
  sortCertViews,
  matchesSearch,
  agePhrase,
  notAfterRelative,
  absoluteDate,
} from "./certificatesDisplay";

// ---------------------------------------------------------------------------
// Certificates panel — cert-manager TLS. Joins certs ← requests ← orders ←
// challenges into per-cert view models, mirrors IngressesPanel's structure.
// Mutations (cancel order/challenge, delete secret, force renew) flow through
// the shared ConfirmSheet like NamespacesPanel.
// ---------------------------------------------------------------------------

const KINDS = [
  "certificates.cert-manager.io",
  "certificaterequests.cert-manager.io",
  "orders.acme.cert-manager.io",
  "challenges.acme.cert-manager.io",
] as const;

export default function CertificatesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [cmctlAvailable, setCmctlAvailable] = useState(false);

  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    KINDS.forEach((k) => subscribe(k, ns));
    return () => KINDS.forEach((k) => unsubscribe(k, ns));
  }, [namespaceFilter]);

  // Probe cmctl once on mount to gate Force-renew.
  useEffect(() => {
    fetchCertManagerPlugin()
      .then(setCmctlAvailable)
      .catch(() => setCmctlAvailable(false));
  }, []);

  const views = useMemo(() => {
    const certs = Object.values(
      (resources["certificates.cert-manager.io"] ?? {}) as Record<string, Certificate>,
    );
    const reqs = Object.values(
      (resources["certificaterequests.cert-manager.io"] ?? {}) as Record<string, CertificateRequest>,
    );
    const orders = Object.values(
      (resources["orders.acme.cert-manager.io"] ?? {}) as Record<string, Order>,
    );
    const challenges = Object.values(
      (resources["challenges.acme.cert-manager.io"] ?? {}) as Record<string, Challenge>,
    );
    return sortCertViews(buildCertViews(certs, reqs, orders, challenges));
  }, [resources]);

  const filtered = useMemo(() => views.filter((v) => matchesSearch(v, search)), [views, search]);

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Certificates"
        subtitle="TLS & cert-manager"
        count={filtered.length}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search certificates…"
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

        {/* Row list */}
        <div className="flex flex-col gap-0.5 px-3 py-2">
          {filtered.map((v) => {
            const isOpen = expanded.has(v.uid);
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => viewYaml("certificate", v.name, v.namespace)}>View YAML…</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => toggleExpand(v.uid)}>{isOpen ? "Collapse" : "Details…"}</ContextMenuItem>
              </>
            );

            return (
              <ListRow
                key={v.uid}
                rowKey={v.uid}
                isOpen={isOpen}
                onToggle={() => toggleExpand(v.uid)}
                contextMenu={rowMenu}
                expandedContent={
                  <CertBody view={v} onAction={setPendingAction} cmctlAvailable={cmctlAvailable} />
                }
              >
                {/* Name */}
                <button
                  type="button"
                  onClick={() => toggleExpand(v.uid)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {v.name}
                </button>

                {/* Namespace pill */}
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
                  {v.namespace ?? "—"}
                </span>

                {/* Status pill */}
                <StatusPill view={v} />

                {/* Spacer */}
                <span className="flex-1" />

                {/* Expiry — dim, only when notAfter is set */}
                {v.notAfter && (
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-tertiary)",
                      whiteSpace: "nowrap",
                    }}
                    title={`Expires ${v.notAfter}`}
                  >
                    exp {expiryLabel(v.notAfter)}
                  </span>
                )}
              </ListRow>
            );
          })}
        </div>

        {/* Empty / filtered-to-zero states */}
        {!isLoading && views.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No certificates found — cert-manager may not be installed.
          </p>
        )}
        {views.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No certificates match search</p>
        )}
      </div>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status pill — Ready (green) / Issuing (amber) / — (gray)
// ---------------------------------------------------------------------------

function StatusPill({ view }: { view: CertView }) {
  let label: string;
  let color: string;
  let background: string;

  if (view.ready) {
    label = "Ready";
    color = "#10B981";
    background = "rgba(16, 185, 129, 0.13)";
  } else if (view.issuing) {
    label = "Issuing";
    color = "#F59E0B";
    background = "rgba(245, 158, 11, 0.15)";
  } else {
    label = "—";
    color = "#6B6B73";
    background = "#1B1C1F";
  }

  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color,
        background,
        padding: "1px 6px",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Expanded body: ISSUANCE CHAIN, DETAILS, cert-level actions
// ---------------------------------------------------------------------------

function CertBody({
  view,
  onAction,
  cmctlAvailable,
}: {
  view: CertView;
  onAction: (a: ActionBlock) => void;
  cmctlAvailable: boolean;
}) {
  function cancelOrder(order: OrderNode) {
    onAction({
      kind: "deleteResource",
      resourceKind: "order",
      name: order.name,
      namespace: order.namespace,
      destructive: true,
      label: `Cancel order ${order.name}`,
    });
  }

  function cancelChallenge(ch: ChallengeNode) {
    onAction({
      kind: "deleteResource",
      resourceKind: "challenge",
      name: ch.name,
      namespace: ch.namespace,
      destructive: true,
      label: `Cancel challenge ${ch.name}`,
    });
  }

  function deleteSecret() {
    onAction({
      kind: "deleteResource",
      resourceKind: "secret",
      name: view.secretName,
      namespace: view.namespace,
      destructive: true,
      label: `Delete secret ${view.secretName}`,
    });
  }

  function forceRenew() {
    onAction({
      kind: "command",
      args: ["cert-manager", "renew", view.name, "-n", view.namespace ?? "default"],
      destructive: true,
      label: `Renew certificate ${view.name}`,
    });
  }

  const notAfterAbs = view.notAfter ? absoluteDate(view.notAfter) : null;
  const notAfterRel = notAfterRelative(view.notAfter);

  const detailRows = [
    {
      key: "DNS NAMES",
      icon: <Globe className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />,
      value: view.dnsNames.length > 0 ? view.dnsNames.join(", ") : "—",
      copy: true,
      copyValue: view.dnsNames.join(", "),
    },
    {
      key: "ISSUER",
      icon: <Shield className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />,
      value: view.issuer,
      copy: false,
    },
    {
      key: "SECRET",
      icon: <Lock className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />,
      value: view.secretName || "—",
      copy: !!view.secretName,
      copyValue: view.secretName,
    },
    {
      key: "NOT AFTER",
      icon: <Calendar className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />,
      value: notAfterRel,
      secondary: notAfterAbs ? `· ${notAfterAbs}` : undefined,
      copy: false,
    },
    {
      key: "AGE",
      icon: <History className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />,
      value: agePhrase(view.cert.metadata.creationTimestamp) || "—",
      copy: false,
      isLast: true,
    },
  ] as const;

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      {/* 1. ISSUANCE CHAIN */}
      <div className="flex flex-col gap-2">
        <SectionLabel>ISSUANCE CHAIN</SectionLabel>
        <div className="flex flex-col gap-1.5 rounded-lg border border-[#26272B] bg-[var(--surface-sunken)] p-3">
          {view.requests.length === 0 ? (
            <span className="text-xs text-muted-foreground">No active issuance.</span>
          ) : (
            view.requests.map((req) => (
              <div key={req.name} className="flex flex-col gap-1.5">
                {/* Request node */}
                <div className="flex items-center gap-2">
                  <RequestStatusIcon ready={req.ready} reason={req.reason} />
                  <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
                    {req.name}
                  </span>
                  <StateChip
                    state={req.ready ? "valid" : (req.reason || "pending")}
                    label={req.ready ? "ready" : (req.reason || "pending")}
                  />
                </div>

                {/* Order node */}
                {req.order && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <ChainConnector />
                        <span className="min-w-0 truncate font-mono text-xs font-medium text-[var(--fg-secondary)]">
                          {req.order.name}
                        </span>
                        <StateChip state={req.order.state} label={req.order.state} />
                      </div>
                      <ChainActionButton
                        label="Cancel order"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelOrder(req.order!);
                        }}
                      />
                    </div>

                    {/* Challenge nodes */}
                    {req.order.challenges.map((ch) => (
                      <div key={ch.name} className="flex items-center gap-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <ChainConnector />
                          <span className="min-w-0 truncate font-mono text-xs font-medium text-[var(--fg-secondary)]">
                            {ch.name}
                          </span>
                          <StateChip state={ch.state} label={ch.state} />
                        </div>
                        <ChainActionButton
                          label="Cancel challenge"
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelChallenge(ch);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 2. DETAILS */}
      <div className="flex flex-col gap-2">
        <SectionLabel>DETAILS</SectionLabel>
        <div className="flex flex-col overflow-hidden rounded-lg border border-[#26272B] bg-[var(--surface-sunken)]">
          {detailRows.map((row, i) => (
            <div
              key={row.key}
              className={`flex items-center gap-3 px-3 py-2 ${i < detailRows.length - 1 ? "border-b border-white/5" : ""}`}
            >
              {/* Key */}
              <span className="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-tertiary)]">
                {row.key}
              </span>

              {/* Value */}
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {row.icon}
                <span className="truncate font-mono text-xs text-[var(--fg-secondary)]">
                  {row.value}
                </span>
                {"secondary" in row && row.secondary && (
                  <span className="shrink-0 text-[11px] text-[var(--fg-tertiary)]">
                    {row.secondary}
                  </span>
                )}
              </div>

              {/* Copy button */}
              {"copy" in row && row.copy && (
                <CopyButton value={"copyValue" in row && row.copyValue ? row.copyValue : row.value} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 3. ACTIONS */}
      <div className="flex items-center gap-2 pt-1">
        {/* Force renew */}
        <button
          type="button"
          disabled={!cmctlAvailable}
          title={!cmctlAvailable ? "cmctl is required for force renew (not available on server)" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (cmctlAvailable) forceRenew();
          }}
          className={`inline-flex items-center gap-1.5 rounded-md bg-white/5 px-3 py-1.5 text-xs font-semibold ${
            cmctlAvailable
              ? "text-[var(--fg-secondary)] hover:bg-white/10"
              : "cursor-not-allowed text-[var(--fg-tertiary)]"
          }`}
        >
          <RefreshCw className="size-3.5" />
          Force renew
        </button>

        {/* Delete secret */}
        {view.secretName && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              deleteSecret();
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" />
            Delete secret
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section label
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-tertiary)]">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Request status icon in the issuance chain
// ---------------------------------------------------------------------------

function RequestStatusIcon({ ready, reason }: { ready: boolean; reason: string }) {
  if (ready) return <CircleCheck className="size-3.5 shrink-0 text-[#10B981]" />;
  const isPending = !reason || reason.toLowerCase().includes("pending") || reason.toLowerCase().includes("process");
  if (isPending) return <Loader className="size-3.5 shrink-0 text-[#F59E0B]" />;
  return <CircleX className="size-3.5 shrink-0 text-destructive" />;
}

// ---------------------------------------------------------------------------
// State chip — colored by state string
// ---------------------------------------------------------------------------

function stateChipClass(state: string): string {
  const s = state.toLowerCase();
  if (s === "valid" || s === "ready" || s === "true") return "text-[#10B981] bg-[#10B981]/15";
  if (s === "pending" || s === "processing" || s === "issuing") return "text-[#F59E0B] bg-[#F59E0B]/15";
  if (s === "invalid" || s === "failed" || s === "errored") return "text-destructive bg-destructive/15";
  return "text-[var(--fg-tertiary)] bg-white/5";
}

function StateChip({ state, label }: { state: string; label: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold ${stateChipClass(state)}`}
    >
      <span className="size-1 rounded-full bg-current" />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// L-shaped chain connector SVG
// ---------------------------------------------------------------------------

function ChainConnector() {
  return (
    <svg viewBox="0 0 20 22" fill="none" className="size-4 shrink-0 text-[#55555E]">
      <path
        d="M2 0 L2 14 Q2 20 8 20 L20 20"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Chain action button (Cancel order / Cancel challenge)
// ---------------------------------------------------------------------------

function ChainActionButton({
  label,
  onClick,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#26272B] px-2 py-1 text-[11px] font-medium text-[var(--fg-secondary)] hover:bg-white/5"
    >
      <X className="size-3" />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Copy button — silent clipboard copy, no state feedback per design spec.
// ---------------------------------------------------------------------------

function CopyButton({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value);
      }}
      className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--fg-tertiary)] hover:bg-white/5"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      <Copy className="size-3.5" />
    </button>
  );
}

