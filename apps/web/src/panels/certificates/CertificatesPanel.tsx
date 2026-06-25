import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { viewYaml } from "@/store/yamlViewer";
import type { ActionBlock } from "@/lib/api";
import { fetchCertManagerPlugin } from "@/lib/api";
import {
  ChevronDown,
  ChevronRight,
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
  FileCode,
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
  buildCertViews,
  sortCertViews,
  matchesSearch,
  expiresPhrase,
  agePhrase,
  notAfterRelative,
  absoluteDate,
} from "./certificatesDisplay";

// ---------------------------------------------------------------------------
// Certificates panel — cert-manager TLS. Joins certs ← requests ← orders ←
// challenges into per-cert view models. Card-based UI matching the Pencil design.
// Mutations (cancel order/challenge, delete secret, force renew) flow through
// the shared ConfirmSheet.
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

        {/* Card list */}
        <div
          className="flex flex-col px-4 py-4"
          style={{ gap: 12 }}
        >
          {filtered.map((v) => {
            const isOpen = expanded.has(v.uid);
            return (
              <CertCard
                key={v.uid}
                view={v}
                isOpen={isOpen}
                onToggle={() => toggleExpand(v.uid)}
                onAction={setPendingAction}
                cmctlAvailable={cmctlAvailable}
              />
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
// CertCard — single certificate rendered as a card with collapsible body.
// ---------------------------------------------------------------------------

function CertCard({
  view,
  isOpen,
  onToggle,
  onAction,
  cmctlAvailable,
}: {
  view: CertView;
  isOpen: boolean;
  onToggle: () => void;
  onAction: (a: ActionBlock) => void;
  cmctlAvailable: boolean;
}) {
  return (
    <div
      style={{
        background: "#0E0E11",
        borderRadius: 16,
        border: "1px solid #FFFFFF12",
        boxShadow: "0 24px 60px 0 #00000059",
        overflow: "hidden",
        width: "100%",
      }}
    >
      {/* Card header */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "18px 24px",
          borderBottom: "1px solid #FFFFFF0A",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {/* Left: chevron + name + namespace + status */}
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 12 }}>
          {isOpen ? (
            <ChevronDown size={18} color="#8C8C95" style={{ flexShrink: 0 }} />
          ) : (
            <ChevronRight size={18} color="#8C8C95" style={{ flexShrink: 0 }} />
          )}

          {/* Name */}
          <span
            style={{
              fontFamily: "Geist, sans-serif",
              fontSize: 17,
              fontWeight: 700,
              color: "#FFFFFF",
            }}
          >
            {view.name}
          </span>

          {/* Namespace chip */}
          {view.namespace && (
            <span
              style={{
                fontFamily: "Geist Mono, monospace",
                fontSize: 12,
                fontWeight: 500,
                color: "#8C8C95",
                background: "#FFFFFF0D",
                borderRadius: 6,
                padding: "3px 10px",
              }}
            >
              {view.namespace}
            </span>
          )}

          {/* Status pill */}
          <StatusPill view={view} />
        </div>

        {/* Right: expiry */}
        {view.notAfter && (
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 7 }}>
            <History size={15} color="#8C8C95" />
            <span
              style={{
                fontFamily: "Geist, sans-serif",
                fontSize: 13,
                fontWeight: 500,
                color: "#8C8C95",
              }}
            >
              {expiresPhrase(view.notAfter)}
            </span>
          </div>
        )}

        {/* View YAML kebab affordance — only visible on hover via opacity trick */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            viewYaml("certificate", view.name, view.namespace);
          }}
          title="View YAML…"
          style={{
            marginLeft: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: 7,
            border: "1px solid #FFFFFF0D",
            background: "transparent",
            cursor: "pointer",
            color: "#8C8C95",
            flexShrink: 0,
          }}
        >
          <FileCode size={14} />
        </button>
      </button>

      {/* Card body (only when expanded) */}
      {isOpen && (
        <CertBody view={view} onAction={onAction} cmctlAvailable={cmctlAvailable} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status pill — Ready / Issuing / Not ready
// ---------------------------------------------------------------------------

function StatusPill({ view }: { view: CertView }) {
  let label: string;
  let color: string;
  let bg: string;

  if (view.ready) {
    label = "Ready";
    color = "#34D07F";
    bg = "#34D07F1F";
  } else if (view.issuing) {
    label = "Issuing";
    color = "#F5A623";
    bg = "#F5A6231F";
  } else {
    label = "Not ready";
    color = "#8C8C95";
    bg = "#FFFFFF0D";
  }

  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        padding: "5px 12px",
        background: bg,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: "Geist, sans-serif",
          fontSize: 13,
          fontWeight: 600,
          color,
        }}
      >
        {label}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card body: Issuance chain + Details + Actions
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
      icon: <Globe size={15} color="#8C8C95" />,
      value: view.dnsNames.length > 0 ? view.dnsNames.join(", ") : "—",
      copy: true,
      copyValue: view.dnsNames.join(", "),
    },
    {
      key: "ISSUER",
      icon: <Shield size={15} color="#8C8C95" />,
      value: view.issuer,
      copy: false,
    },
    {
      key: "SECRET",
      icon: <Lock size={15} color="#8C8C95" />,
      value: view.secretName || "—",
      copy: !!view.secretName,
      copyValue: view.secretName,
    },
    {
      key: "NOT AFTER",
      icon: <Calendar size={15} color="#8C8C95" />,
      value: notAfterRel,
      secondary: notAfterAbs ? `· ${notAfterAbs}` : undefined,
      copy: false,
    },
    {
      key: "AGE",
      icon: <History size={15} color="#8C8C95" />,
      value: agePhrase(view.cert.metadata.creationTimestamp),
      copy: false,
      isLast: true,
    },
  ] as const;

  return (
    <div
      style={{
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 22,
      }}
    >
      {/* 1. ISSUANCE CHAIN */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SectionLabel>ISSUANCE CHAIN</SectionLabel>
        <div
          style={{
            background: "#141417",
            borderRadius: 12,
            border: "1px solid #FFFFFF0D",
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {view.requests.length === 0 ? (
            <span style={{ fontFamily: "Geist, sans-serif", fontSize: 13, color: "#8C8C95" }}>
              No active issuance.
            </span>
          ) : (
            view.requests.map((req) => (
              <div key={req.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {/* Request node */}
                <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <RequestStatusIcon ready={req.ready} reason={req.reason} />
                  <span
                    style={{
                      fontFamily: "Geist Mono, monospace",
                      fontSize: 14,
                      fontWeight: 500,
                      color: "#FFFFFF",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {req.name}
                  </span>
                  <StateChip
                    state={req.ready ? "valid" : (req.reason || "pending")}
                    label={req.ready ? "ready" : (req.reason || "pending")}
                  />
                </div>

                {/* Order node */}
                {req.order && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 10 }}>
                      <ChainConnector />
                      <span
                        style={{
                          fontFamily: "Geist Mono, monospace",
                          fontSize: 14,
                          fontWeight: 500,
                          color: "#D2D2D8",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                      >
                        {req.order.name}
                      </span>
                      <StateChip state={req.order.state} label={req.order.state} />
                      <div style={{ flex: 1 }} />
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
                      <div key={ch.name} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 10 }}>
                        <ChainConnector />
                        <span
                          style={{
                            fontFamily: "Geist Mono, monospace",
                            fontSize: 14,
                            fontWeight: 500,
                            color: "#D2D2D8",
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                          }}
                        >
                          {ch.name}
                        </span>
                        <StateChip state={ch.state} label={ch.state} />
                        <div style={{ flex: 1 }} />
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
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SectionLabel>DETAILS</SectionLabel>
        <div
          style={{
            background: "#141417",
            borderRadius: 12,
            border: "1px solid #FFFFFF0D",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {detailRows.map((row, i) => (
            <div
              key={row.key}
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: 18,
                padding: "14px 18px",
                borderBottom: i < detailRows.length - 1 ? "1px solid #FFFFFF0A" : undefined,
              }}
            >
              {/* Key */}
              <span
                style={{
                  width: 150,
                  flexShrink: 0,
                  fontFamily: "Geist, sans-serif",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#7E7E87",
                  letterSpacing: "0.8px",
                  textTransform: "uppercase",
                }}
              >
                {row.key}
              </span>

              {/* Value */}
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 9,
                  minWidth: 0,
                }}
              >
                {row.icon}
                <span
                  style={{
                    fontFamily: "Geist Mono, monospace",
                    fontSize: 13.5,
                    fontWeight: 500,
                    color: "#D2D2D8",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.value}
                </span>
                {"secondary" in row && row.secondary && (
                  <span
                    style={{
                      fontFamily: "Geist, sans-serif",
                      fontSize: 13,
                      fontWeight: 400,
                      color: "#8C8C95",
                      whiteSpace: "nowrap",
                    }}
                  >
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
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingTop: 6,
        }}
      >
        {/* Force renew */}
        <button
          type="button"
          disabled={!cmctlAvailable}
          title={!cmctlAvailable ? "cmctl is required for force renew — not available on server" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (cmctlAvailable) forceRenew();
          }}
          style={{
            display: "inline-flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            background: "#FFFFFF08",
            borderRadius: 9,
            border: "none",
            padding: "11px 18px",
            cursor: cmctlAvailable ? "pointer" : "not-allowed",
          }}
        >
          <RefreshCw size={15} color={cmctlAvailable ? "#D2D2D8" : "#5A5A62"} />
          <span
            style={{
              fontFamily: "Geist, sans-serif",
              fontSize: 14,
              fontWeight: 600,
              color: cmctlAvailable ? "#D2D2D8" : "#5A5A62",
            }}
          >
            Force renew
          </span>
        </button>

        {/* Delete secret */}
        {view.secretName && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              deleteSecret();
            }}
            style={{
              display: "inline-flex",
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              background: "transparent",
              borderRadius: 9,
              border: "1px solid #FF6B6B33",
              padding: "11px 18px",
              cursor: "pointer",
            }}
          >
            <Trash2 size={15} color="#FF6B6B" />
            <span
              style={{
                fontFamily: "Geist, sans-serif",
                fontSize: 14,
                fontWeight: 600,
                color: "#FF6B6B",
              }}
            >
              Delete secret
            </span>
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
    <span
      style={{
        fontFamily: "Geist, sans-serif",
        fontSize: 12,
        fontWeight: 600,
        color: "#7E7E87",
        letterSpacing: "1.2px",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Request status icon in the issuance chain
// ---------------------------------------------------------------------------

function RequestStatusIcon({ ready, reason }: { ready: boolean; reason: string }) {
  if (ready) return <CircleCheck size={17} color="#34D07F" style={{ flexShrink: 0 }} />;
  const isPending = !reason || reason.toLowerCase().includes("pending") || reason.toLowerCase().includes("process");
  if (isPending) return <Loader size={17} color="#F5A623" style={{ flexShrink: 0 }} />;
  return <CircleX size={17} color="#FF6B6B" style={{ flexShrink: 0 }} />;
}

// ---------------------------------------------------------------------------
// State chip — colored by state string
// ---------------------------------------------------------------------------

function stateColors(state: string): { color: string; bg: string } {
  const s = state.toLowerCase();
  if (s === "valid" || s === "ready" || s === "true") {
    return { color: "#34D07F", bg: "#34D07F1F" };
  }
  if (s === "pending" || s === "processing" || s === "issuing") {
    return { color: "#F5A623", bg: "#F5A6231F" };
  }
  if (s === "invalid" || s === "failed" || s === "errored") {
    return { color: "#FF6B6B", bg: "#FF6B6B1F" };
  }
  return { color: "#8C8C95", bg: "#FFFFFF0D" };
}

function StateChip({ state, label }: { state: string; label: string }) {
  const { color, bg } = stateColors(state);
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        borderRadius: 999,
        padding: "2px 8px",
        background: bg,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: "Geist, sans-serif",
          fontSize: 12,
          fontWeight: 600,
          color,
        }}
      >
        {label}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// L-shaped chain connector SVG
// ---------------------------------------------------------------------------

function ChainConnector() {
  return (
    <svg
      width={20}
      height={22}
      viewBox="0 0 20 22"
      fill="none"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M2 0 L2 14 Q2 20 8 20 L20 20"
        stroke="#55555E"
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
      style={{
        display: "inline-flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 8,
        border: "1px solid #FFFFFF0D",
        padding: "7px 14px",
        background: "transparent",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <X size={14} color="#8C8C95" />
      <span
        style={{
          fontFamily: "Geist, sans-serif",
          fontSize: 13,
          fontWeight: 500,
          color: "#D2D2D8",
        }}
      >
        {label}
      </span>
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
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 7,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        flexShrink: 0,
      }}
      title="Copy to clipboard"
    >
      <Copy size={15} color="#8C8C95" />
    </button>
  );
}
