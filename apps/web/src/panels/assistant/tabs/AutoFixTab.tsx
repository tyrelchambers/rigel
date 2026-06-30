// AutoFixTab — the agent-opened fix-PR control surface. Reproduces the Pencil
// "Auto Fix" tab (frame qv5Tx): an opt-in card (Off/On toggle, daily cap, the
// "Applies to" scope list of per-project link status) plus a "Recent pull
// requests" list. Scope is per-project ONLY — a "🔍 Add project" search row lists
// the user's deployments (as <namespace>/<deployment>) and adds one as a project;
// an unlinked pick opens the LinkRepoModal (frame xSyQL) to create its GitOps
// source on the spot. Tailwind utilities + design tokens only.

import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  Box,
  Check,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Link as LinkIcon,
  Search,
  SquareArrowOutUpRight,
  TriangleAlert,
  X,
} from "lucide-react";
import type { AssistantPullRequest } from "@rigel/k8s";
import { parseRepoSlug } from "@rigel/k8s";
import { cn } from "@/lib/utils";
import { useCluster } from "@/store/cluster";
import { useSetAutofix } from "@/lib/api";
import { useRepoLink } from "@/panels/gitops/gitApi";
import { useAssistantCtx } from "../AssistantContext";
import { relativeTime } from "../display";
import { LinkRepoModal } from "../components/LinkRepoModal";

type Scope = { projects: string[] };
interface LinkTarget {
  namespace: string;
  deployment: string;
}

const dedupe = (xs: string[]) => Array.from(new Set(xs));

/** Split a "<namespace>/<deployment>" project id into its parts. */
function splitProject(id: string): LinkTarget {
  const i = id.indexOf("/");
  return i === -1
    ? { namespace: "", deployment: id }
    : { namespace: id.slice(0, i), deployment: id.slice(i + 1) };
}

export function AutoFixTab() {
  const { d } = useAssistantCtx();

  return (
    <div className="space-y-5">
      <OptInCard />
      <RecentPrCard prs={d.pullRequests} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opt-in card
// ---------------------------------------------------------------------------

function OptInCard() {
  const { d, ns } = useAssistantCtx();
  const setAutofix = useSetAutofix();
  const { enabled, maxPerDay, scope } = d.autofix;

  const [maxText, setMaxText] = useState(String(maxPerDay));
  // Re-seed the cap field whenever the live config changes.
  useEffect(() => setMaxText(String(maxPerDay)), [maxPerDay]);

  // The project being linked (an unlinked pill, or an unlinked search pick). The
  // modal is prefilled with its namespace/deployment.
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);

  const working = setAutofix.isPending;
  const commit = (input: { enabled?: boolean; maxPerDay?: number; scope?: Scope }) =>
    setAutofix.mutate({ namespace: ns, ...input });

  const setScope = (next: Scope) => commit({ scope: next });
  const addProject = (id: string) => setScope({ projects: dedupe([...scope.projects, id]) });
  const removeProject = (id: string) =>
    setScope({ projects: scope.projects.filter((x) => x !== id) });

  const commitMax = () => {
    const n = Number(maxText);
    if (Number.isFinite(n) && n >= 0 && Math.floor(n) !== maxPerDay) commit({ maxPerDay: Math.floor(n) });
  };

  return (
    <div className="space-y-3.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-4">
      {/* Header — title/sub + Off/On toggle */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-[15px] font-semibold text-[var(--fg-primary)]">Auto-fix</p>
          <p className="text-xs text-[var(--fg-secondary)]">
            Open a pull request when Rigel finds a fixable error
          </p>
        </div>
        <Toggle
          enabled={enabled}
          disabled={working}
          onChange={(next) => commit({ enabled: next })}
        />
      </div>

      <p className="text-[13px] leading-[1.5] text-[var(--fg-secondary)]">
        When Rigel diagnoses an error it can fix, it opens a pull request with the change and an
        explanation. You review and merge. Rigel only pushes a branch; it never merges or deploys.
      </p>

      <div className="h-px bg-[var(--border-subtle)]" />

      {/* Max PRs per day */}
      <label className="flex flex-col gap-2">
        <span className="text-xs font-medium text-[var(--fg-secondary)]">Max PRs per day</span>
        <input
          type="number"
          min={0}
          value={maxText}
          disabled={working}
          aria-label="Max PRs per day"
          onChange={(e) => setMaxText(e.target.value)}
          onBlur={commitMax}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5 font-mono text-xs text-[var(--fg-primary)] outline-none transition-colors focus:border-[var(--accent-primary)] disabled:opacity-50"
        />
      </label>

      {/* Applies to — project scope list */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-[var(--fg-secondary)]">Applies to</p>
        <ScopeList
          scope={scope}
          working={working}
          onAddProject={addProject}
          onRemoveProject={removeProject}
          onLink={setLinkTarget}
        />
        <p className="text-[11px] leading-[1.45] text-[var(--fg-tertiary)]">
          Add each project (deployment) Rigel may open fixes for. Adding an unlinked project lets
          you create its GitOps source on the spot; once linked, Rigel can open fixes against it.
        </p>
      </div>

      {/* Notification note */}
      <div className="flex items-center gap-2">
        <Bell className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
        <span className="text-[11px] text-[var(--fg-tertiary)]">
          Notifications use your configured channel (Matrix, Signal, or webhook).
        </span>
      </div>

      {setAutofix.error && (
        <p className="font-mono text-[11px] text-[var(--status-failed)]">{setAutofix.error.message}</p>
      )}

      <LinkRepoModal
        open={linkTarget !== null}
        onOpenChange={(o) => !o && setLinkTarget(null)}
        namespace={linkTarget?.namespace ?? ""}
        deployment={linkTarget?.deployment ?? ""}
        onLinked={() => {
          if (linkTarget) addProject(`${linkTarget.namespace}/${linkTarget.deployment}`);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Off / On segmented toggle (RulesTab-style mode selector, per the design)
// ---------------------------------------------------------------------------

function Toggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const seg = (active: boolean) =>
    cn(
      "rounded-[5px] px-3.5 py-1.5 text-xs transition-colors disabled:opacity-50",
      active
        ? "bg-[var(--accent-dim)] font-semibold text-[var(--accent-primary)]"
        : "text-[var(--fg-tertiary)] hover:text-[var(--fg-secondary)]",
    );
  return (
    <div
      role="group"
      aria-label="Auto-fix"
      className="inline-flex items-center gap-0.5 rounded-md border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-0.5"
    >
      <button type="button" disabled={disabled} aria-pressed={!enabled} onClick={() => onChange(false)} className={seg(!enabled)}>
        Off
      </button>
      <button type="button" disabled={disabled} aria-pressed={enabled} onClick={() => onChange(true)} className={seg(enabled)}>
        On
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scope list (project rows + the search-to-add control)
// ---------------------------------------------------------------------------

function ScopeList({
  scope,
  working,
  onAddProject,
  onRemoveProject,
  onLink,
}: {
  scope: Scope;
  working: boolean;
  onAddProject: (id: string) => void;
  onRemoveProject: (id: string) => void;
  onLink: (t: LinkTarget) => void;
}) {
  const empty = scope.projects.length === 0;

  return (
    <div className="divide-y divide-[var(--border-subtle)] overflow-visible rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
      {empty && (
        <p className="px-3 py-2.5 text-[11px] italic text-[var(--fg-tertiary)]">
          Nothing opted in yet. Add a project below.
        </p>
      )}
      {scope.projects.map((p) => (
        <ProjectScopeRow
          key={p}
          projectId={p}
          working={working}
          onRemove={() => onRemoveProject(p)}
          onLink={onLink}
        />
      ))}
      <AddProjectControl
        scope={scope}
        working={working}
        onAddProject={onAddProject}
        onLink={onLink}
      />
    </div>
  );
}

const ROW = "flex items-center justify-between gap-3 px-3 py-2.5";

function RemoveButton({ onRemove, working, label }: { onRemove: () => void; working: boolean; label: string }) {
  return (
    <button
      type="button"
      disabled={working}
      aria-label={label}
      onClick={onRemove}
      className="shrink-0 text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-primary)] disabled:opacity-50"
    >
      <X className="size-3.5" />
    </button>
  );
}

function ProjectScopeRow({
  projectId,
  working,
  onRemove,
  onLink,
}: {
  projectId: string;
  working: boolean;
  onRemove: () => void;
  onLink: (t: LinkTarget) => void;
}) {
  const { namespace, deployment } = splitProject(projectId);
  const { data: status } = useRepoLink(namespace, deployment);
  const link = status?.link ?? null;
  const linked = status?.linked ?? false;
  const repoLabel = link
    ? link.repo ?? (() => {
        const slug = parseRepoSlug(link.repoURL);
        return slug ? `${slug.owner}/${slug.repo}` : link.repoURL;
      })()
    : null;

  return (
    <div className={ROW}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Box className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-[var(--fg-primary)]">{deployment}</span>
          <span className="text-[11px] text-[var(--fg-tertiary)]">
            {linked ? "project" : "project · not linked"}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {linked ? (
          <span className="flex items-center gap-1.5">
            <GitBranch className="size-[13px] text-[var(--fg-tertiary)]" />
            <span className="font-mono text-xs text-[var(--fg-secondary)]">{repoLabel}</span>
          </span>
        ) : (
          <button
            type="button"
            disabled={working}
            onClick={() => onLink({ namespace, deployment })}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--status-pending)] px-2.5 py-1 font-mono text-[11px] text-[var(--status-pending)] transition-colors hover:bg-[var(--status-pending)]/10 disabled:opacity-50"
          >
            <LinkIcon className="size-3" />
            Link to repo
          </button>
        )}
        <RemoveButton onRemove={onRemove} working={working} label={`Remove ${deployment}`} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Add project" — a searchable list of the user's deployments (as
// <namespace>/<deployment>), sourced from the panel's cluster-wide deployments
// watch in the store (NOT a per-namespace subscription, which raced the wildcard
// watch and showed nothing). Picking a linked deployment adds it directly; an
// unlinked one opens the LinkRepoModal so its GitOps source is created on the spot.
// ---------------------------------------------------------------------------

interface DeploymentLite {
  metadata?: { name?: string; namespace?: string };
}
interface ProjectOption {
  id: string;
  namespace: string;
  deployment: string;
}

/** A picked deployment whose link status is being resolved: `checking` while the
 *  /api/git/link read is in flight, `error` if that CHECK failed (distinct from a
 *  genuine "unlinked" result — we surface it and let the user retry, never assume
 *  unlinked). A success resolves out of this state (add directly, or open the
 *  Link modal). */
interface Resolution {
  target: LinkTarget;
  status: "checking" | "error";
}

function AddProjectControl({
  scope,
  working,
  onAddProject,
  onLink,
}: {
  scope: Scope;
  working: boolean;
  onAddProject: (id: string) => void;
  onLink: (t: LinkTarget) => void;
}) {
  // The cluster-wide deployments map kept by the store and fed by the panel's
  // `(deployments, "*")` watch (useAssistant). Reading it directly gives every
  // deployment across every namespace with no extra subscription to race.
  const deploymentsMap = useCluster((s) => s.resources["deployments"]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The picked deployment whose link status is being resolved (then add-or-link),
  // or whose check errored.
  const [resolution, setResolution] = useState<Resolution | null>(null);

  // Resolve the picked deployment's link status. The hook is always called (null
  // target → disabled), so the add-or-link decision uses the SAME read the rows do.
  const linkQuery = useRepoLink(
    resolution?.target.namespace ?? null,
    resolution?.target.deployment ?? null,
  );

  useEffect(() => {
    if (resolution?.status !== "checking") return;
    // Wait until the read settles — never act on an in-flight / being-refetched
    // state (this is what makes Retry safe against the cached error result).
    if (linkQuery.fetchStatus !== "idle") return;
    if (linkQuery.isError) {
      // A CHECK error is not "unlinked": surface it + offer retry; do not add or
      // open the modal.
      setResolution({ target: resolution.target, status: "error" });
    } else if (linkQuery.isSuccess && linkQuery.data) {
      const t = resolution.target;
      setResolution(null);
      if (linkQuery.data.linked) onAddProject(`${t.namespace}/${t.deployment}`);
      else onLink(t);
    }
  }, [resolution, linkQuery.fetchStatus, linkQuery.isError, linkQuery.isSuccess, linkQuery.data, onAddProject, onLink]);

  const options = useMemo<ProjectOption[]>(() => {
    const map = (deploymentsMap ?? {}) as Record<string, DeploymentLite>;
    return Object.values(map)
      .map((d) => ({ namespace: d.metadata?.namespace ?? "", deployment: d.metadata?.name ?? "" }))
      .filter((d) => d.namespace !== "" && d.deployment !== "")
      .map((d) => ({ ...d, id: `${d.namespace}/${d.deployment}` }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [deploymentsMap]);

  const filtered = query
    ? options.filter((o) => o.id.toLowerCase().includes(query.toLowerCase()))
    : options;

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const pick = (o: ProjectOption) => {
    close();
    // Defer the add-or-link decision to the resolver effect (it needs link status).
    setResolution({ target: { namespace: o.namespace, deployment: o.deployment }, status: "checking" });
  };

  const retry = () => {
    if (!resolution) return;
    setResolution({ target: resolution.target, status: "checking" });
    void linkQuery.refetch();
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={working}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.02] disabled:opacity-50"
      >
        <Search className="size-3.5 text-[var(--accent-primary)]" />
        <span className="text-xs text-[var(--accent-primary)]">Add project</span>
      </button>

      {resolution?.status === "error" && (
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5">
          <TriangleAlert className="size-3.5 shrink-0 text-[var(--status-failed)]" />
          <span className="min-w-0 flex-1 text-[11px] text-[var(--status-failed)]">
            Couldn't check {resolution.target.deployment}. {linkQuery.error?.message ?? "Link check failed."}
          </span>
          <button
            type="button"
            onClick={retry}
            className="shrink-0 rounded-md border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)]"
          >
            Retry
          </button>
        </div>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute right-0 bottom-full left-0 z-50 mb-1 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] shadow-lg">
            <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2">
              <Search className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search deployments…"
                aria-label="Search deployments"
                className="w-full bg-transparent text-xs text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {filtered.map((o) => {
                const added = scope.projects.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="option"
                    aria-selected={added}
                    disabled={added}
                    onClick={() => pick(o)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.04] disabled:opacity-60"
                  >
                    <Box className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[var(--fg-primary)]">{o.deployment}</span>
                      <span className="truncate font-mono text-[10px] text-[var(--fg-tertiary)]">
                        {o.namespace}
                      </span>
                    </span>
                    {added && <Check className="ml-auto size-3.5 shrink-0 text-[var(--accent-primary)]" />}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <p className="px-3 py-2 text-[11px] italic text-[var(--fg-tertiary)]">
                  {options.length === 0 ? "No deployments found" : "No matching deployments"}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent pull requests
// ---------------------------------------------------------------------------

function prSummary(prs: AssistantPullRequest[]): string {
  const count = (s: AssistantPullRequest["status"]) => prs.filter((p) => p.status === s).length;
  const parts: string[] = [];
  for (const [s, label] of [
    ["open", "open"],
    ["merged", "merged"],
    ["failed", "failed"],
  ] as const) {
    const n = count(s);
    if (n > 0) parts.push(`${n} ${label}`);
  }
  return parts.join(" · ");
}

function RecentPrCard({ prs }: { prs: AssistantPullRequest[] }) {
  const summary = prSummary(prs);
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-3.5 py-3">
        <p className="text-sm font-semibold text-[var(--fg-primary)]">Recent pull requests</p>
        {summary && <p className="font-mono text-[11px] text-[var(--fg-tertiary)]">{summary}</p>}
      </div>
      {prs.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-xs text-[var(--fg-tertiary)]">
          No pull requests yet. Rigel opens one when it finds a fixable error.
        </p>
      ) : (
        prs.map((pr) => <PrRow key={`${pr.fingerprint}|${pr.filePath}|${pr.at}`} pr={pr} />)
      )}
    </div>
  );
}

/** Per-status badge + leading-icon styling. The agent emits open/failed today;
 *  merged is covered for forward-compat (and matches the design). */
function prStatusMeta(status: AssistantPullRequest["status"]) {
  switch (status) {
    case "merged":
      return { label: "Merged", Icon: GitMerge, dot: "bg-purple-500", icon: "text-purple-500" };
    case "failed":
      return {
        label: "Failed",
        Icon: GitPullRequestClosed,
        dot: "bg-[var(--status-failed)]",
        icon: "text-[var(--status-failed)]",
      };
    default:
      return {
        label: "Open",
        Icon: GitPullRequest,
        dot: "bg-[var(--status-running)]",
        icon: "text-[var(--status-running)]",
      };
  }
}

function PrRow({ pr }: { pr: AssistantPullRequest }) {
  const meta = prStatusMeta(pr.status);
  const slug = parseRepoSlug(pr.repo);
  const repoLabel = slug ? `${slug.owner}/${slug.repo}` : pr.repo || pr.app;
  const rel = relativeTime(pr.at);
  const subtitle = [repoLabel, pr.branch, rel ? `${rel} ago` : null].filter(Boolean).join(" · ");

  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-3.5 py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <meta.Icon className={cn("size-4 shrink-0", meta.icon)} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-[var(--fg-primary)]">{pr.title}</span>
          <span className="truncate font-mono text-[11px] text-[var(--fg-tertiary)]">{subtitle}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-1">
          <span className={cn("size-[7px] rounded-full", meta.dot)} />
          <span className="text-[11px] text-[var(--fg-secondary)]">{meta.label}</span>
        </span>
        {pr.prUrl && (
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${pr.title} in browser`}
            className="text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-primary)]"
          >
            <SquareArrowOutUpRight className="size-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}
