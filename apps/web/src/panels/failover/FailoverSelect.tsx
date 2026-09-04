import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { PanelSearch } from "@/panels/components/PanelSearch";
import { PanelSelect } from "@/panels/components/PanelSelect";
import {
  candidateDetail,
  candidateKey,
  failoverCandidates,
  selectionFromCandidates,
  type FailoverCandidate,
} from "./failoverCandidates";

const WATCHED = ["deployments", "statefulsets", "services", "ingresses"] as const;

export function FailoverSelect({
  onPreview,
  previewPending,
}: {
  onPreview: (selection: ReturnType<typeof selectionFromCandidates>) => void;
  previewPending: boolean;
}) {
  const resources = useCluster((s) => s.resources);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [namespace, setNamespace] = useState("all");

  useEffect(() => {
    for (const kind of WATCHED) subscribe(kind, "*");
    return () => {
      for (const kind of WATCHED) unsubscribe(kind, "*");
    };
  }, []);

  const candidates = useMemo(
    () =>
      failoverCandidates(
        [
          ...Object.values(resources["deployments"] ?? {}),
          ...Object.values(resources["statefulsets"] ?? {}),
        ] as Parameters<typeof failoverCandidates>[0],
        Object.values(resources["services"] ?? {}) as Parameters<typeof failoverCandidates>[1],
        Object.values(resources["ingresses"] ?? {}) as Parameters<typeof failoverCandidates>[2],
      ),
    [resources],
  );

  const namespaces = useMemo(
    () => [...new Set(candidates.map((c) => c.namespace))].sort(),
    [candidates],
  );

  const shown = candidates.filter(
    (c) =>
      (namespace === "all" || c.namespace === namespace) &&
      (search === "" || `${c.namespace}/${c.name}`.toLowerCase().includes(search.toLowerCase())),
  );

  function toggle(c: FailoverCandidate) {
    setPicked((prev) => {
      const next = new Set(prev);
      const key = candidateKey(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const pickedCandidates = candidates.filter((c) => picked.has(candidateKey(c)));
  const allShownPicked = shown.length > 0 && shown.every((c) => picked.has(candidateKey(c)));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-[9px]">
        <h2 className="text-sm font-semibold">Choose what moves</h2>
        <span className="rounded-[4px] border border-[var(--border-subtle)] bg-white/5 px-[9px] py-[2px] font-mono text-xs font-semibold text-muted-foreground">
          {picked.size} selected
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Pick the customer-facing apps. Anything you leave unchecked stays down. One plan is built from
        whatever you check.
      </p>

      <div className="flex flex-wrap items-center gap-2.5">
        <PanelSearch value={search} onValueChange={setSearch} placeholder="Search workloads…" ariaLabel="Search workloads" className="w-[240px]" />
        <PanelSelect value={namespace} onValueChange={setNamespace} ariaLabel="Namespace" className="w-[180px]">
          <option value="all">All namespaces</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </PanelSelect>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            setPicked((prev) => {
              const next = new Set(prev);
              for (const c of shown) {
                if (allShownPicked) next.delete(candidateKey(c));
                else next.add(candidateKey(c));
              }
              return next;
            })
          }
        >
          {allShownPicked ? "Clear these" : "Select these"}
        </Button>
      </div>

      {candidates.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No Deployments or StatefulSets outside cluster plumbing yet.
        </p>
      )}

      <ul className="flex flex-col divide-y divide-[var(--border-subtle)]">
        {shown.map((c) => {
          const key = candidateKey(c);
          const checked = picked.has(key);
          return (
            <li key={key}>
              <label className="flex cursor-pointer items-start gap-2.5 py-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(c)}
                  aria-label={`${c.namespace}/${c.name}`}
                  className="mt-0.5 size-3.5 accent-[var(--accent-primary)]"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-2xs text-[var(--fg-primary)]">{c.name}</span>
                    <span className="font-mono text-2xs text-[var(--fg-tertiary)]">{c.namespace}</span>
                  </span>
                  <span className="font-mono text-2xs text-[var(--fg-secondary)]">{candidateDetail(c)}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={picked.size === 0 || previewPending}
          onClick={() => onPreview(selectionFromCandidates(pickedCandidates))}
        >
          Preview plan
        </Button>
        <p className="text-xs text-[var(--fg-tertiary)]">
          Builds the closure, data plans, and portability findings. Nothing is created yet.
        </p>
      </div>
    </section>
  );
}
