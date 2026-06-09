import { Fragment, useEffect, useMemo, useState } from "react";
import { LoaderCircle, ChevronRight, ChevronDown, Lock } from "lucide-react";
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
// DEFERRED ACTIONS (docs/parity/ingresses.md §"Row Actions: NONE"). This is a
// read-only panel. The following are intentionally NOT implemented and must
// NOT be added without a new feature spec + infra:
//   - Edit / Create / Delete ingress mutations (need ConfirmSheet wiring +
//     server action routes + ingress form UI: class, routing rules, TLS,
//     cert-manager — reuse the pods/nodes ConfirmSheet pattern later).
//     Delete maps to action-block kind "deleteResource" with resourceKind
//     "ingress": `kubectl delete ingress <name> -n <namespace>`.
//   - Ask Claude handoff (needs an ingress-diagnostics context builder).
//   - View YAML (needs a server YAML endpoint + viewer UI).
//   - Cert-manager integration / automatic HTTPS (loads ClusterIssuers).
// ---------------------------------------------------------------------------

export default function IngressesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Subscribe to the ingresses watch for the active namespace (or all).
  // Re-subscribes when the namespace filter changes.
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

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Ingresses</h1>
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
          placeholder="Search ingresses…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Error banner */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6" />
            <TableHead>Namespace</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Class</TableHead>
            <TableHead>Hosts</TableHead>
            <TableHead>TLS</TableHead>
            <TableHead>External Address</TableHead>
            <TableHead>Age</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((ing) => {
            const uid = ing.metadata.uid;
            const isOpen = expanded.has(uid);
            const cls = className(ing);
            const hostList = hosts(ing);
            const tls = isTLS(ing);
            const external = externalAddress(ing);
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
                    {ing.metadata.namespace ?? "—"}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => toggleExpand(uid)}
                      className="font-mono hover:underline"
                    >
                      {ing.metadata.name}
                    </button>
                  </TableCell>
                  <TableCell>
                    {cls === "—" ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {cls}
                      </span>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-[18rem] truncate font-mono text-muted-foreground"
                    title={hostList.join(", ") || undefined}
                  >
                    {hostList.length > 0 ? hostList.join(", ") : "—"}
                  </TableCell>
                  <TableCell>
                    {tls ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        <Lock className="size-3" />
                        TLS
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-[16rem] truncate font-mono text-muted-foreground"
                    title={external ?? undefined}
                  >
                    {external ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {relativeAge(ing.metadata.creationTimestamp)}
                  </TableCell>
                </TableRow>

                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={8} className="bg-muted/30">
                      <IngressDetail ingress={ing} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && filtered.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No ingresses found</p>
      )}
    </div>
  );
}

/** Expanded detail: ROUTES, TLS (if any), DETAILS (class + address). */
function IngressDetail({ ingress }: { ingress: Ingress }) {
  const routes = flattenRoutes(ingress);
  const tlsEntries = ingress.spec?.tls ?? [];
  const cls = className(ingress);
  const external = externalAddress(ingress);

  return (
    <div className="space-y-3 px-2 py-3">
      {/* ROUTES */}
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Routes ({routes.length})
        </h3>
        {routes.length === 0 ? (
          <p className="text-xs text-muted-foreground">No routing rules</p>
        ) : (
          <table className="text-xs font-mono">
            <tbody>
              {routes.map((r, i) => (
                <tr key={`${r.host}-${r.path}-${i}`}>
                  <td className="pr-4 text-muted-foreground">{r.host}</td>
                  <td className="pr-2">{r.path}</td>
                  <td className="px-2 text-muted-foreground">→</td>
                  <td>
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
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            TLS
          </h3>
          <ul className="space-y-0.5 text-xs font-mono">
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Details
        </h3>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-0.5 text-xs font-mono">
          <dt className="text-muted-foreground">CLASS</dt>
          <dd>{cls}</dd>
          <dt className="text-muted-foreground">ADDRESS</dt>
          <dd className="break-all">{external ?? "—"}</dd>
        </dl>
      </div>
    </div>
  );
}
