import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ListRow } from "@/panels/components/ListRow";
import { PanelHeader } from "@/panels/components/PanelHeader";
import type { ActionBlock } from "@/lib/api";
import { fetchCertManagerPlugin } from "@/lib/api";
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
  relativeAge,
  buildCertViews,
  sortCertViews,
  matchesSearch,
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

            return (
              <ListRow
                key={v.uid}
                rowKey={v.uid}
                isOpen={isOpen}
                onToggle={() => toggleExpand(v.uid)}
                expandedContent={
                  <CertDetail view={v} onAction={setPendingAction} cmctlAvailable={cmctlAvailable} />
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
                    exp {relativeAge(v.notAfter)} ago
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
// Small subtle action button used in the issuance chain + cert-level actions.
// ---------------------------------------------------------------------------

function SmallButton({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick(e);
      }}
      className="shrink-0 rounded font-mono transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        fontSize: 10,
        padding: "2px 7px",
        color: "var(--fg-secondary)",
        background: "var(--surface-elevated)",
        border: "1px solid #26272B",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.borderColor = "#34353A";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#26272B";
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail: ISSUANCE CHAIN, DETAILS, cert-level actions
// ---------------------------------------------------------------------------

function CertDetail({
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

  return (
    <div className="space-y-3">
      {/* ISSUANCE CHAIN */}
      <div className="space-y-1">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Issuance chain
        </h3>
        {view.requests.length === 0 ? (
          <p className="text-xs text-muted-foreground">No active issuance requests</p>
        ) : (
          <div className="space-y-1.5 text-xs font-mono">
            {view.requests.map((req) => (
              <div key={req.name} className="space-y-1">
                {/* CertificateRequest */}
                <div className="flex items-center gap-2">
                  <span style={{ color: "var(--fg-secondary)" }}>{req.name}</span>
                  <span style={{ color: req.ready ? "var(--status-running)" : "var(--fg-tertiary)" }}>
                    {req.ready ? "ready" : req.reason || "pending"}
                  </span>
                </div>

                {/* Order */}
                {req.order && (
                  <div className="ml-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <span style={{ color: "var(--fg-tertiary)" }}>↳</span>
                      <span style={{ color: "var(--fg-secondary)" }}>{req.order.name}</span>
                      <span style={{ color: "var(--fg-tertiary)" }}>·</span>
                      <span style={{ color: "var(--fg-secondary)" }}>{req.order.state}</span>
                      {req.order.reason && (
                        <>
                          <span style={{ color: "var(--fg-tertiary)" }}>·</span>
                          <span style={{ color: "var(--fg-tertiary)" }}>{req.order.reason}</span>
                        </>
                      )}
                      <SmallButton label="Cancel order" onClick={() => cancelOrder(req.order!)} />
                    </div>

                    {/* Challenges */}
                    {req.order.challenges.map((ch) => (
                      <div key={ch.name} className="ml-4 flex items-center gap-2">
                        <span style={{ color: "var(--fg-tertiary)" }}>↳</span>
                        <span style={{ color: "var(--fg-secondary)" }}>{ch.type}</span>
                        <span style={{ color: "var(--fg-tertiary)" }}>·</span>
                        <span style={{ color: "var(--fg-secondary)" }}>{ch.dnsName}</span>
                        <span style={{ color: "var(--fg-tertiary)" }}>·</span>
                        <span style={{ color: "var(--fg-secondary)" }}>{ch.state}</span>
                        {ch.reason && (
                          <>
                            <span style={{ color: "var(--fg-tertiary)" }}>·</span>
                            <span style={{ color: "var(--fg-tertiary)" }}>{ch.reason}</span>
                          </>
                        )}
                        <SmallButton label="Cancel challenge" onClick={() => cancelChallenge(ch)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* DETAILS */}
      <div className="space-y-1">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Details
        </h3>
        <dl
          className="grid gap-x-4 gap-y-0.5 text-xs font-mono"
          style={{ gridTemplateColumns: "6rem 1fr" }}
        >
          <dt style={{ color: "var(--fg-tertiary)" }}>DNS NAMES</dt>
          <dd className="break-all" style={{ color: "var(--fg-secondary)" }}>
            {view.dnsNames.join(", ") || "—"}
          </dd>
          <dt style={{ color: "var(--fg-tertiary)" }}>ISSUER</dt>
          <dd style={{ color: "var(--fg-secondary)" }}>{view.issuer}</dd>
          <dt style={{ color: "var(--fg-tertiary)" }}>SECRET</dt>
          <dd className="break-all" style={{ color: "var(--fg-secondary)" }}>{view.secretName || "—"}</dd>
          <dt style={{ color: "var(--fg-tertiary)" }}>NOT AFTER</dt>
          <dd style={{ color: "var(--fg-secondary)" }}>
            {view.notAfter ? `${relativeAge(view.notAfter)} left` : "—"}
          </dd>
          <dt style={{ color: "var(--fg-tertiary)" }}>AGE</dt>
          <dd style={{ color: "var(--fg-secondary)" }}>
            {relativeAge(view.cert.metadata.creationTimestamp)} ago
          </dd>
        </dl>
      </div>

      {/* Cert-level actions */}
      <div className="flex items-center gap-2 pt-1">
        <SmallButton
          label="Force renew"
          onClick={forceRenew}
          disabled={!cmctlAvailable}
          title={!cmctlAvailable ? "cmctl not available on server" : undefined}
        />
        {view.secretName && <SmallButton label="Delete secret" onClick={deleteSecret} />}
      </div>
    </div>
  );
}
