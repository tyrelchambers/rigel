import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { PanelHeader } from "@/panels/components/PanelHeader";
import type { Ingress } from "./types";
import {
  relativeAge,
  className,
  isTLS,
  flattenRoutes,
  externalAddress,
  matchesSearch,
  sortIngresses,
} from "./ingressesDisplay";

// ---------------------------------------------------------------------------
// Read-only panel. Errors/Logs/Explain handoffs use handoffToChat.
// ---------------------------------------------------------------------------

export default function IngressesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("ingresses", ns);
    return () => unsubscribe("ingresses", ns);
  }, [namespaceFilter]);

  const allIngresses = useMemo(
    () => sortIngresses(Object.values((resources["ingresses"] ?? {}) as Record<string, Ingress>)),
    [resources],
  );
  const filtered = useMemo(
    () => allIngresses.filter((i) => matchesSearch(i, search)),
    [allIngresses, search],
  );

  const shown = filtered.length;

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function askClaude(ing: Ingress, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(buildHandoffPrompt("ingress", ing.metadata.name, ing.metadata.namespace, topic));
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Ingresses"
        subtitle="HTTP routing & TLS"
        count={shown}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ingresses…"
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
        {filtered.map((ing) => {
          const uid = ing.metadata.uid;
          const isOpen = expanded.has(uid);
          const cls = className(ing);
          const tls = isTLS(ing);
          const routes = flattenRoutes(ing);
          const primary = routes[0];

          return (
            <ListRow
              key={uid}
              rowKey={uid}
              isOpen={isOpen}
              onToggle={() => toggleExpand(uid)}
              expandedContent={<IngressDetail ingress={ing} />}
            >
              {/* Two-line content (mirrors the Swift ingress row) */}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {/* Line 1: name · namespace · class · TLS */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleExpand(uid)}
                    className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                  >
                    {ing.metadata.name}
                  </button>

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
                    {ing.metadata.namespace ?? "—"}
                  </span>

                  {cls !== "—" && <TagPill label={cls} />}

                  {tls && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--status-running)",
                        background: "rgba(16, 185, 129, 0.13)",
                        padding: "1px 6px",
                        borderRadius: 4,
                        whiteSpace: "nowrap",
                      }}
                      title="TLS enabled"
                    >
                      <Lock size={9} strokeWidth={2.5} />
                      TLS
                    </span>
                  )}
                </div>

                {/* Line 2: primary route — host / → service:port */}
                {primary && (
                  <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                    <span className="truncate" style={{ color: "var(--fg-primary)" }} title={primary.host}>
                      {primary.host}
                    </span>
                    <span style={{ color: "var(--fg-tertiary)", flexShrink: 0 }}>{primary.path}</span>
                    <span style={{ color: "var(--fg-tertiary)", flexShrink: 0 }}>→</span>
                    <span
                      className="truncate"
                      style={{ color: "var(--accent-primary)", flexShrink: 0 }}
                      title={`${primary.service}${primary.port ? `:${primary.port}` : ""}`}
                    >
                      {primary.service}
                      {primary.port ? `:${primary.port}` : ""}
                    </span>
                    {routes.length > 1 && (
                      <span style={{ color: "var(--fg-tertiary)", flexShrink: 0 }}>+{routes.length - 1}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Action strip — Errors / Logs / Explain */}
              <ActionButtonStrip
                onErrors={(e) => { e.stopPropagation(); askClaude(ing, "Errors"); }}
                onLogs={(e) => { e.stopPropagation(); askClaude(ing, "Logs"); }}
                onExplain={(e) => { e.stopPropagation(); askClaude(ing, "Explain"); }}
              />
            </ListRow>
          );
        })}
      </div>

        {/* Empty / filtered-to-zero states */}
        {!isLoading && allIngresses.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No ingresses found</p>
        )}
        {!isLoading && allIngresses.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No ingresses match search</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail: ROUTES, TLS (if any), DETAILS
// ---------------------------------------------------------------------------

function IngressDetail({ ingress }: { ingress: Ingress }) {
  const routes = flattenRoutes(ingress);
  const tlsEntries = ingress.spec?.tls ?? [];
  const cls = className(ingress);
  const external = externalAddress(ingress);

  return (
    <div className="space-y-3">
      {/* ROUTES */}
      <div className="space-y-1">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Routes ({routes.length})
        </h3>
        {routes.length === 0 ? (
          <p className="text-xs text-muted-foreground">No routing rules</p>
        ) : (
          <table className="text-xs font-mono">
            <tbody>
              {routes.map((r, i) => (
                <tr key={`${r.host}-${r.path}-${i}`}>
                  <td className="pr-4" style={{ color: "var(--fg-tertiary)" }}>{r.host}</td>
                  <td className="pr-2">{r.path}</td>
                  <td className="px-2" style={{ color: "var(--fg-tertiary)" }}>→</td>
                  <td style={{ color: "var(--fg-secondary)" }}>
                    {r.service}
                    {r.port ? `:${r.port}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* TLS (only when present) */}
      {tlsEntries.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            TLS
          </h3>
          <ul className="space-y-0.5 text-xs font-mono" style={{ color: "var(--fg-secondary)" }}>
            {tlsEntries.map((t, i) => {
              const h = (t.hosts ?? []).join(", ") || "—";
              return (
                <li key={`${t.secretName ?? "tls"}-${i}`}>
                  {h} → {t.secretName ?? "—"}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* DETAILS: class + external address */}
      <div className="space-y-1">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Details
        </h3>
        <dl
          className="grid gap-x-4 gap-y-0.5 text-xs font-mono"
          style={{ gridTemplateColumns: "6rem 1fr" }}
        >
          <dt style={{ color: "var(--fg-tertiary)" }}>CLASS</dt>
          <dd style={{ color: "var(--fg-secondary)" }}>{cls}</dd>
          <dt style={{ color: "var(--fg-tertiary)" }}>ADDRESS</dt>
          <dd className="break-all" style={{ color: "var(--fg-secondary)" }}>{external ?? "—"}</dd>
          <dt style={{ color: "var(--fg-tertiary)" }}>AGE</dt>
          <dd style={{ color: "var(--fg-secondary)" }}>{relativeAge(ingress.metadata.creationTimestamp)} ago</dd>
        </dl>
      </div>
    </div>
  );
}
