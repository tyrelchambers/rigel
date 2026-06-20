import { useEffect, useMemo, useState } from "react";
import { Star, Package, BadgeCheck, ShieldCheck } from "lucide-react";
import { useArtifactHubBrowse, type ArtifactHubChart } from "./helmApi";

export function BrowseChartsView({ onPickChart }: { onPickChart: (c: ArtifactHubChart) => void }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [official, setOfficial] = useState(false);
  const [verified, setVerified] = useState(false);

  // Debounce the search box so each keystroke doesn't refetch.
  useEffect(() => {
    const id = setTimeout(() => setQuery(input), 300);
    return () => clearTimeout(id);
  }, [input]);

  const params = useMemo(() => ({ query, official, verified }), [query, official, verified]);
  const browse = useArtifactHubBrowse(params);

  // Dedupe by repo/name/version: Artifact Hub can return the same chart from
  // multiple repos, and offset pagination can repeat an item across pages.
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (browse.data?.pages ?? []).flatMap((p) => p.items).filter((c) => {
      const k = `${c.repoName}/${c.name}/${c.version}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [browse.data]);
  const total = browse.data?.pages?.[0]?.total ?? 0;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="min-w-[220px] flex-1 rounded-md border bg-transparent px-2.5 py-1.5 text-sm"
          style={{ borderColor: "var(--border-strong)" }}
          placeholder="Search charts…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <Toggle label="Official" active={official} onClick={() => setOfficial((v) => !v)} icon={BadgeCheck} />
        <Toggle label="Verified" active={verified} onClick={() => setVerified((v) => !v)} icon={ShieldCheck} />
      </div>

      {/* Results */}
      {browse.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading charts…</p>
      ) : browse.isError ? (
        <p className="text-sm text-muted-foreground">Couldn't reach Artifact Hub.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No charts found.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {items.map((c) => (
              <ChartCard key={`${c.repoName}/${c.name}/${c.version}`} chart={c} onClick={() => onPickChart(c)} />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {items.length}{total ? ` of ${total}` : ""}</span>
            {browse.hasNextPage && (
              <button
                type="button"
                className="rounded-md px-3 py-1.5 hover:bg-white/[0.05]"
                disabled={browse.isFetchingNextPage}
                onClick={() => browse.fetchNextPage()}
              >
                {browse.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ label, active, onClick, icon: Icon }: { label: string; active: boolean; onClick: () => void; icon: typeof BadgeCheck }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm"
      style={{ background: active ? "rgba(255,255,255,0.1)" : "transparent", border: "1px solid var(--border-strong)" }}
    >
      <Icon className="size-3.5" /> {label}
    </button>
  );
}

function ChartCard({ chart, onClick }: { chart: ArtifactHubChart; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-1.5 rounded-lg border p-3 text-left hover:bg-white/[0.04]"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <div className="flex items-center gap-2">
        {chart.logoURL ? (
          <img src={chart.logoURL} alt="" className="size-6 rounded" />
        ) : (
          <Package className="size-6 text-muted-foreground" />
        )}
        <span className="truncate font-medium">{chart.displayName}</span>
        {chart.official && (
          <span title="Official" className="inline-flex shrink-0">
            <BadgeCheck className="size-3.5 text-sky-400" aria-hidden="true" />
            <span className="sr-only">Official</span>
          </span>
        )}
        {chart.verifiedPublisher && !chart.official && (
          <span title="Verified publisher" className="inline-flex shrink-0">
            <ShieldCheck className="size-3.5 text-emerald-400" aria-hidden="true" />
            <span className="sr-only">Verified publisher</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{chart.repoName} · {chart.version}</span>
        <span className="ml-auto inline-flex items-center gap-1 shrink-0"><Star className="size-3" /> {chart.stars}</span>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{chart.description}</p>
    </button>
  );
}
