import { useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBellSlash,
  faChevronDown,
  faChevronRight,
  faCircleCheck,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { Issue, IssueCategory, IssueGroup, IssueSeverity } from "@rigel/k8s/src/issues/types";
import { compactAge } from "@/lib/time";
import { useCluster } from "@/store/cluster";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { PanelSearch } from "@/panels/components/PanelSearch";
import { PanelSelect } from "@/panels/components/PanelSelect";
import {
  CATEGORY_LABELS,
  IssueRow,
  MutedIssueRow,
  SEVERITY_LABELS,
  SeverityGlyph,
} from "./IssueRow";
import { ISSUE_KINDS, useIssues } from "./useIssues";
import { useIssueMutes } from "./useIssueMutes";

const SEVERITIES: IssueSeverity[] = ["critical", "warning", "info"];
const LIVE_MARKER_TICK_MS = 5000;

function matchesSearch(issue: Issue, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    issue.title.toLowerCase().includes(q) ||
    issue.cause.toLowerCase().includes(q) ||
    issue.subject.name.toLowerCase().includes(q) ||
    issue.subject.namespace.toLowerCase().includes(q)
  );
}

function matchesGroup(
  group: IssueGroup,
  search: string,
  severity: string,
  category: string,
): boolean {
  if (severity !== "all" && group.lead.severity !== severity) return false;
  if (category !== "all" && group.lead.category !== category) return false;
  return group.members.some((m) => matchesSearch(m, search));
}

function LiveMarker({ updatedAt }: { updatedAt: Date }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), LIVE_MARKER_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="size-1.5 rounded-full bg-[var(--status-running)]" />
      <span className="text-2xs text-[var(--fg-tertiary)]">
        Auto-updating, updated {compactAge(updatedAt.getTime(), { suffix: true, clampFuture: true })}
      </span>
    </span>
  );
}

function SeverityChip({
  severity,
  count,
  active,
  onToggle,
}: {
  severity: IssueSeverity;
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1 transition-colors ${
        active
          ? "border-[var(--border-strong)] bg-[var(--surface-elevated)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-sunken)]"
      }`}
    >
      <SeverityGlyph severity={severity} />
      <span
        className={`text-2xs font-bold ${active ? "text-[var(--fg-primary)]" : "text-[var(--fg-secondary)]"}`}
      >
        {SEVERITY_LABELS[severity]}
      </span>
      <span
        className={`font-mono text-2xs font-semibold ${active ? "text-[var(--fg-primary)]" : "text-[var(--fg-tertiary)]"}`}
      >
        {count}
      </span>
    </button>
  );
}

function EmptyState({
  title,
  body,
  mutedCount,
  onShowMuted,
}: {
  title: string;
  body: string;
  mutedCount: number;
  onShowMuted: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-6 py-16">
      <FontAwesomeIcon icon={faCircleCheck} className="size-5 text-[var(--status-running)]" />
      <p className="text-sm font-bold text-[var(--fg-primary)]">{title}</p>
      <p className="text-xs text-[var(--fg-tertiary)]">{body}</p>
      {mutedCount > 0 && (
        <span className="flex items-center gap-1.5 pt-1.5">
          <FontAwesomeIcon icon={faBellSlash} className="size-3 text-[var(--fg-tertiary)]" />
          <span className="text-2xs text-[var(--fg-tertiary)]">
            {mutedCount} muted {mutedCount === 1 ? "issue is" : "issues are"} hidden
          </span>
          <button
            type="button"
            onClick={onShowMuted}
            className="text-2xs font-bold text-[var(--accent-primary)] hover:underline"
          >
            Show
          </button>
        </span>
      )}
    </div>
  );
}

export default function IssuesPanel() {
  const { issues, muted, groups, loading, updatedAt } = useIssues();
  const { mute, unmute } = useIssueMutes();
  const resources = useCluster((s) => s.resources);

  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [mutedOpen, setMutedOpen] = useState(false);

  const counts = useMemo(() => {
    const out: Record<IssueSeverity, number> = { critical: 0, warning: 0, info: 0 };
    for (const i of issues) out[i.severity] += 1;
    return out;
  }, [issues]);

  const watched = useMemo(() => {
    const namespaces = new Set<string>();
    let objects = 0;
    for (const kind of ISSUE_KINDS) {
      const slice = resources[kind];
      if (!slice) continue;
      for (const o of Object.values(slice) as { metadata?: { namespace?: string } }[]) {
        objects += 1;
        if (o.metadata?.namespace) namespaces.add(o.metadata.namespace);
      }
    }
    return { objects, namespaces: namespaces.size };
  }, [resources]);

  const visible = useMemo(
    () => groups.filter((g) => matchesGroup(g, search, severity, category)),
    [groups, search, severity, category],
  );

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSeverity(value: IssueSeverity) {
    setSeverity((prev) => (prev === value ? "all" : value));
  }

  function showMuted() {
    setMutedOpen(true);
  }

  const filtered = search.trim() !== "" || severity !== "all" || category !== "all";

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Issues"
        subtitle="Live cluster problems detected from your watched resources."
        count={issues.length}
        loading={loading}
      >
        <PanelSearch
          value={search}
          onValueChange={setSearch}
          placeholder="Search issues"
          className="w-56"
        />
        <PanelSelect
          value={severity}
          onValueChange={setSeverity}
          ariaLabel="Filter by severity"
          className="max-w-44"
        >
          <option value="all">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABELS[s]}
            </option>
          ))}
        </PanelSelect>
        <PanelSelect
          value={category}
          onValueChange={setCategory}
          ariaLabel="Filter by category"
          className="max-w-44"
        >
          <option value="all">All categories</option>
          {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </PanelSelect>
      </PanelHeader>

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-5 py-2.5">
        {SEVERITIES.map((s) => (
          <SeverityChip
            key={s}
            severity={s}
            count={counts[s]}
            active={severity === s}
            onToggle={() => toggleSeverity(s)}
          />
        ))}
        <span className="flex-1" />
        <LiveMarker updatedAt={updatedAt} />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="flex flex-col gap-2 px-5 pt-3.5 pb-5">
          {visible.length === 0 ? (
            <EmptyState
              title={filtered ? "No matching issues" : "No issues right now"}
              body={
                filtered
                  ? `None of the ${issues.length} live issues match the current filters.`
                  : `Rigel is watching ${watched.objects} resources across ${watched.namespaces} namespaces. Anything that breaks lands here.`
              }
              mutedCount={muted.length}
              onShowMuted={showMuted}
            />
          ) : (
            visible.map((g) => (
              <IssueRow
                key={g.key}
                group={g}
                isOpen={expanded.has(g.key)}
                onToggle={() => toggleExpand(g.key)}
                onMute={mute}
              />
            ))
          )}
        </div>

        {muted.length > 0 && (
          <div className="flex flex-col gap-3.5 px-5 pb-5">
            <button
              type="button"
              onClick={() => setMutedOpen((o) => !o)}
              aria-expanded={mutedOpen}
              className="flex items-center gap-2.5"
            >
              <FontAwesomeIcon
                icon={mutedOpen ? faChevronDown : faChevronRight}
                className="size-3 text-[var(--fg-tertiary)]"
              />
              <span className="text-xs font-bold text-[var(--fg-primary)]">Muted</span>
              <span className="rounded-sm border border-[var(--border-subtle)] bg-white/5 px-1.5 py-px font-mono text-2xs font-semibold text-[var(--fg-tertiary)]">
                {muted.length}
              </span>
              <span className="h-px flex-1 bg-[var(--border-subtle)]" />
            </button>

            {mutedOpen && (
              <div className="flex flex-col gap-2 pt-0.5">
                {muted.map((issue) => (
                  <MutedIssueRow
                    key={issue.fingerprint}
                    issue={issue}
                    onUnmute={() => unmute(issue.fingerprint)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
