import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import type { Ingress } from "./types";
import {
  relativeAge,
  className,
  isTLS,
  hosts,
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

  const total = allIngresses.length;
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

  function askClaude(ing: Ingress, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(buildHandoffPrompt("ingress", ing.metadata.name, ing.metadata.namespace, topic));
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ borderBottom: "1px solid #1A1A1A", background: "#141417" }}
      >
        <div className="flex flex-col gap-0">
          <span className="text-sm font-semibold leading-tight">Ingresses</span>
          <span style={{ fontSize: 11, color: "#6B6B73" }}>HTTP routing &amp; TLS</span>
        </div>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "#6B6B73",
            background: "#1A1A1A",
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          {countLabel}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ingresses…"
          className="ml-auto w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

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
          const hostList = hosts(ing);
          const tls = isTLS(ing);
          const external = externalAddress(ing);

          return (
            <ListRow
              key={uid}
              rowKey={uid}
              isOpen={isOpen}
              onToggle={() => toggleExpand(uid)}
              expandedContent={<IngressDetail ingress={ing} />}
            >
              {/* Name */}
              <button
                type="button"
                onClick={() => toggleExpand(uid)}
                className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
              >
                {ing.metadata.name}
              </button>

              {/* Namespace chip */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "#6B6B73",
                  background: "#050505",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid #1A1A1A",
                  whiteSpace: "nowrap",
                }}
              >
                {ing.metadata.namespace ?? "—"}
              </span>

              {/* Class — purple TagPill (only when set) */}
              {cls !== "—" && <TagPill label={cls} />}

              {/* Hosts — dim, truncated */}
              {hostList.length > 0 && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#A1A1AA",
                    whiteSpace: "nowrap",
                    flexShrink: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                  }}
                  title={hostList.join(", ")}
                >
                  {hostList.join(", ")}
                </span>
              )}

              {/* Spacer */}
              <span className="flex-1" />

              {/* TLS badge */}
              <StatusBadge
                label={tls ? "TLS" : "no TLS"}
                variant={tls ? "healthy" : "neutral"}
                title={tls ? "TLS enabled" : "No TLS configured"}
              />

              {/* External address — dim */}
              {external && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#A1A1AA",
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
                  <td className="pr-4" style={{ color: "#6B6B73" }}>{r.host}</td>
                  <td className="pr-2">{r.path}</td>
                  <td className="px-2" style={{ color: "#6B6B73" }}>→</td>
                  <td style={{ color: "#A1A1AA" }}>
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
          <ul className="space-y-0.5 text-xs font-mono" style={{ color: "#A1A1AA" }}>
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
          <dt style={{ color: "#6B6B73" }}>CLASS</dt>
          <dd style={{ color: "#A1A1AA" }}>{cls}</dd>
          <dt style={{ color: "#6B6B73" }}>ADDRESS</dt>
          <dd className="break-all" style={{ color: "#A1A1AA" }}>{external ?? "—"}</dd>
          <dt style={{ color: "#6B6B73" }}>AGE</dt>
          <dd style={{ color: "#A1A1AA" }}>{relativeAge(ingress.metadata.creationTimestamp)} ago</dd>
        </dl>
      </div>
    </div>
  );
}
