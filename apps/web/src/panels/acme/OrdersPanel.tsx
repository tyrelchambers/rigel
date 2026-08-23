import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe, faShield, faCalendar } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useCluster, filterByNamespace } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { goToResource } from "@/lib/resourceNav";
import { viewYaml } from "@/store/yamlViewer";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ListRow } from "@/panels/components/ListRow";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { PanelSearch } from "@/panels/components/PanelSearch";
import { PanelSelect } from "@/panels/components/PanelSelect";
import { PanelSort, applySort } from "@/panels/components/PanelSort";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { MetaCard, SectionLabel } from "@/panels/components/MetaCard";
import type { ActionBlock } from "@/lib/api";
import type { Order, Challenge, CertificateRequest, Certificate } from "@/panels/certificates/types";
import { relativeAge } from "@/panels/pods/podDisplay";
import {
  buildOrderRows,
  matchesOrderSearch,
  matchesAcmeState,
  acmeStateVariant,
  orderSortOptions,
  type OrderRow,
} from "./acmeChain";

const ORDER_KINDS = [
  "orders.acme.cert-manager.io",
  "certificaterequests.cert-manager.io",
  "certificates.cert-manager.io",
] as const;

export default function OrdersPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [sortValue, setSortValue] = useState("namespace");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);

  useEffect(() => {
    ORDER_KINDS.forEach((k) => subscribe(k, "*"));
    return () => ORDER_KINDS.forEach((k) => unsubscribe(k, "*"));
  }, []);

  const allRows = useMemo(() => {
    const orders = filterByNamespace(
      resources["orders.acme.cert-manager.io"] as Record<string, Order> | undefined,
      namespaceFilter,
    );
    const challenges = filterByNamespace(
      resources["challenges.acme.cert-manager.io"] as Record<string, Challenge> | undefined,
      namespaceFilter,
    );
    const requests = filterByNamespace(
      resources["certificaterequests.cert-manager.io"] as Record<string, CertificateRequest> | undefined,
      namespaceFilter,
    );
    const certs = filterByNamespace(
      resources["certificates.cert-manager.io"] as Record<string, Certificate> | undefined,
      namespaceFilter,
    );
    return buildOrderRows(orders, challenges, requests, certs);
  }, [resources, namespaceFilter]);

  const sortOptions = useMemo(() => orderSortOptions(), []);

  const filtered = useMemo(() => {
    const matched = allRows.filter(
      (r) => matchesOrderSearch(r, search) && matchesAcmeState(r.state, stateFilter),
    );
    return applySort(matched, sortOptions.find((o) => o.value === sortValue), sortDir);
  }, [allRows, search, stateFilter, sortOptions, sortValue, sortDir]);

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function handleDelete(row: OrderRow) {
    setPendingAction({
      kind: "deleteResource",
      resourceKind: "order",
      name: row.name,
      namespace: row.namespace,
      destructive: true,
      label: `Delete order ${row.name}`,
    });
  }

  function goToCertificate(row: OrderRow) {
    if (!row.certificate?.uid) return;
    goToResource(navigate, {
      kind: "certificates.cert-manager.io",
      name: row.certificate.name,
      namespace: row.certificate.namespace,
      uid: row.certificate.uid,
      key: row.certificate.namespace
        ? `${row.certificate.namespace}/${row.certificate.name}`
        : row.certificate.name,
      status: "ok",
    });
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Orders" subtitle="ACME orders" count={filtered.length} loading={isLoading}>
        <PanelSearch
          value={search}
          onValueChange={setSearch}
          placeholder="Search orders…"
          className="w-56"
        />
        <PanelSelect value={stateFilter} onValueChange={setStateFilter} ariaLabel="Filter by state" className="max-w-44">
          <option value="all">All states</option>
          <option value="active">Active</option>
          <option value="failed">Failed</option>
          <option value="valid">Valid</option>
        </PanelSelect>
        <PanelSort
          options={sortOptions}
          value={sortValue}
          onValueChange={setSortValue}
          direction={sortDir}
          onDirectionChange={setSortDir}
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
        {error && (
          <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}

        <div className="flex flex-col gap-0.5 px-3 py-2">
          {filtered.map((row) => {
            const isOpen = expanded.has(row.uid);
            const failed = matchesAcmeState(row.state, "failed");

            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => viewYaml("order", row.name, row.namespace)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(row.uid)}>{isOpen ? "Collapse" : "Expand"}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => handleDelete(row)}>Delete…</ContextMenuItem>
              </>
            );

            return (
              <ListRow
                key={row.uid}
                rowKey={row.uid}
                isOpen={isOpen}
                onToggle={() => toggleExpand(row.uid)}
                contextMenu={rowMenu}
                expandedContent={<OrderDetail row={row} onGoToCertificate={goToCertificate} />}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(row.uid)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {row.name}
                </button>

                <span className="shrink-0 whitespace-nowrap rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[5px] py-px font-mono text-3xs text-[var(--fg-tertiary)]">
                  {row.namespace ?? "—"}
                </span>

                <StatusBadge label={row.state} variant={acmeStateVariant(row.state)} />

                {failed && row.reason && (
                  <span
                    className="min-w-0 max-w-64 truncate text-3xs text-muted-foreground"
                    title={row.reason}
                  >
                    {row.reason}
                  </span>
                )}

                <span className="flex-1" />

                {row.certificate ? (
                  row.certificate.uid ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        goToCertificate(row);
                      }}
                      className="shrink-0 truncate font-mono text-3xs text-[var(--accent-primary)] hover:underline"
                      title={row.certificate.name}
                    >
                      {row.certificate.name}
                    </button>
                  ) : (
                    <span
                      className="shrink-0 truncate font-mono text-3xs text-[var(--fg-secondary)]"
                      title={row.certificate.name}
                    >
                      {row.certificate.name}
                    </span>
                  )
                ) : (
                  <span className="shrink-0 font-mono text-3xs text-[var(--fg-tertiary)]">—</span>
                )}

                <span className="shrink-0 whitespace-nowrap font-mono text-3xs text-[var(--fg-tertiary)]">
                  {row.issuer}
                </span>

                <span className="shrink-0 whitespace-nowrap font-mono text-3xs text-[var(--fg-tertiary)]">
                  {relativeAge(row.createdAt)}
                </span>
              </ListRow>
            );
          })}
        </div>

        {!isLoading && allRows.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No ACME orders found — cert-manager may not be installed or no ACME issuance has run.
          </p>
        )}
        {!isLoading && allRows.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No orders match your filters</p>
        )}
      </div>

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}

function OrderDetail({
  row,
  onGoToCertificate,
}: {
  row: OrderRow;
  onGoToCertificate: (row: OrderRow) => void;
}) {
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex gap-3">
        <MetaCard label="STATE">
          <div className="flex flex-col gap-2">
            <StatusBadge label={row.state} variant={acmeStateVariant(row.state)} />
            {row.reason && (
              <span className="text-xs text-[var(--fg-secondary)]">{row.reason}</span>
            )}
          </div>
        </MetaCard>

        <MetaCard label="ISSUER">
          <div className="flex items-center gap-[7px]">
            <FontAwesomeIcon icon={faShield} className="size-[13px] text-[var(--fg-tertiary)]" />
            <span className="font-mono text-xs text-[var(--fg-secondary)]">{row.issuer}</span>
          </div>
        </MetaCard>

        <MetaCard label="CERTIFICATE">
          {row.certificate ? (
            row.certificate.uid ? (
              <button
                type="button"
                onClick={() => onGoToCertificate(row)}
                className="truncate font-mono text-xs text-[var(--accent-primary)] hover:underline"
                title={row.certificate.name}
              >
                {row.certificate.name}
              </button>
            ) : (
              <span className="truncate font-mono text-xs text-[var(--fg-secondary)]" title={row.certificate.name}>
                {row.certificate.name}
              </span>
            )
          ) : (
            <span className="font-mono text-xs text-[var(--fg-tertiary)]">—</span>
          )}
        </MetaCard>

        <MetaCard label="AGE">
          <div className="flex items-center gap-[7px]">
            <FontAwesomeIcon icon={faCalendar} className="size-[13px] text-[var(--fg-tertiary)]" />
            <span className="text-sm text-[var(--fg-secondary)]">{relativeAge(row.createdAt)}</span>
          </div>
        </MetaCard>
      </div>

      <div className="flex flex-col gap-[9px]">
        <SectionLabel>DNS NAMES</SectionLabel>
        {row.dnsNames.length === 0 ? (
          <span className="text-xs text-[var(--fg-tertiary)]">—</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {row.dnsNames.map((n) => (
              <span
                key={n}
                className="inline-flex items-center gap-[7px] rounded-sm bg-white/[0.05] px-2.5 py-[5px] font-mono text-xs text-foreground"
              >
                <FontAwesomeIcon icon={faGlobe} className="size-3 text-[var(--fg-tertiary)]" />
                {n}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-[9px]">
        <SectionLabel>{`CHALLENGES · ${row.challenges.length}`}</SectionLabel>
        {row.challenges.length === 0 ? (
          <span className="text-xs text-[var(--fg-tertiary)]">No challenges</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {row.challenges.map((ch) => (
              <div
                key={ch.uid}
                className="flex items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{ch.name}</span>
                <span className="shrink-0 font-mono text-2xs text-[var(--fg-tertiary)]">{ch.type}</span>
                <StatusBadge label={ch.state} variant={acmeStateVariant(ch.state)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
