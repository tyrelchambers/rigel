// Settings → Overview: what this app is, which version is installed, and a
// software-updates card driven by the desktop auto-updater (electron-updater via
// useAppUpdate) plus best-effort GitHub release metadata (rigel.about.get()).
import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { Check, Download, LoaderCircle, RotateCw, RefreshCw, ArrowUpRight, TriangleAlert } from "lucide-react";
import { RigelMark } from "@/components/RigelMark";
import { rigel, isDesktop, type AboutInfo } from "@/lib/desktop";
import { useAppUpdate } from "@/shell/useAppUpdate";
import { cn } from "@/lib/utils";

/** Turn a release-notes markdown body into a short highlight list: strip bullet /
 *  heading markers, drop blanks, cap the count. */
export function releaseHighlights(notes: string, max = 6): string[] {
  return notes
    .split("\n")
    .map((l) => l.replace(/^\s*[-*#>]+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, max);
}

export function OverviewTab() {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const update = useAppUpdate();

  const loadAbout = useCallback(() => {
    rigel?.about?.get().then((a) => {
      setAbout(a);
      setLastChecked(Date.now());
    }).catch(() => {});
  }, []);
  useEffect(() => { loadAbout(); }, [loadAbout]);

  const check = () => {
    setLastChecked(Date.now());
    update.check();
    loadAbout();
  };

  const version = about?.version ?? null;

  return (
    <div className="space-y-8">
      {/* Identity */}
      <div className="flex items-center gap-5">
        <div className="flex size-[72px] shrink-0 items-center justify-center rounded-[18px] border border-[var(--border-subtle)] bg-[linear-gradient(135deg,var(--surface-elevated),color-mix(in_oklab,var(--accent-primary)_14%,var(--surface-elevated)))]">
          <RigelMark size={40} color="var(--accent-primary)" />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span className="font-heading text-2xl font-bold text-foreground">Rigel</span>
            {version && (
              <span className="rounded-[4px] border border-[var(--border-subtle)] bg-white/[0.05] px-2 py-0.5 font-mono text-xs font-semibold text-muted-foreground">
                v{version}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">The Kubernetes command deck.</p>
          {about?.buildDate && (
            <p className="text-xs text-[var(--fg-tertiary)]">
              Released {format(new Date(about.buildDate), "MMMM d, yyyy")}
            </p>
          )}
        </div>
      </div>

      {/* Software updates */}
      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[15px] font-semibold text-foreground">Software updates</h2>
            <p className="text-xs text-[var(--fg-tertiary)]">
              Rigel checks for updates automatically every few hours.
            </p>
          </div>
          {isDesktop && update.status !== "downloading" && update.status !== "downloaded" && (
            <button
              type="button"
              onClick={check}
              className="flex shrink-0 items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className={cn("size-3.5", update.status === "checking" && "animate-spin")} />
              Check for updates
            </button>
          )}
        </div>

        <div className="mt-4">
          <UpdateBody
            update={update}
            version={version}
            lastCheckedLabel={lastChecked ? `Checked ${format(new Date(lastChecked), "p")}` : null}
          />
        </div>
      </section>
    </div>
  );
}

function UpdateBody({
  update,
  version,
  lastCheckedLabel,
}: {
  update: ReturnType<typeof useAppUpdate>;
  version: string | null;
  lastCheckedLabel: string | null;
}) {
  if (!isDesktop) {
    return (
      <p className="text-[13px] text-[var(--fg-tertiary)]">
        Updates are managed by the Rigel desktop app.
      </p>
    );
  }

  if (update.status === "error") {
    return (
      <StatusRow tone="pending" icon={<TriangleAlert className="size-[18px] text-[var(--status-pending)]" />}>
        <span className="text-sm font-semibold text-foreground">Couldn't check for updates</span>
        <span className="text-[13px] text-[var(--fg-tertiary)]">Try again in a moment, or download from the website.</span>
      </StatusRow>
    );
  }

  if (update.status === "downloaded") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusRow tone="running" icon={<Check className="size-[18px] text-[var(--status-running)]" />} className="flex-1">
          <span className="text-sm font-semibold text-foreground">Update ready to install</span>
          <span className="text-[13px] text-[var(--fg-tertiary)]">Rigel {update.version} has been downloaded.</span>
        </StatusRow>
        <PrimaryButton onClick={update.install} icon={<RotateCw className="size-3.5" />}>Restart to update</PrimaryButton>
      </div>
    );
  }

  if (update.status === "downloading") {
    return (
      <div className="flex flex-col gap-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-4">
        <div className="flex items-center gap-2">
          <LoaderCircle className="size-4 animate-spin text-[var(--accent-primary)]" />
          <span className="text-sm font-semibold text-foreground">Downloading {update.version}…</span>
          <span className="ml-auto font-mono text-xs text-[var(--accent-primary)]">{update.progress}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--accent-primary)_20%,transparent)]">
          <div
            className="h-full rounded-full bg-[var(--accent-primary)] transition-[width] duration-200"
            style={{ width: `${Math.max(0, Math.min(100, update.progress))}%` }}
          />
        </div>
      </div>
    );
  }

  if (update.status === "available") {
    const highlights = update.releaseNotes ? releaseHighlights(update.releaseNotes) : [];
    return (
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13px] text-[var(--fg-tertiary)]">Current version</span>
            <span className="font-mono text-[13px] font-semibold text-muted-foreground">v{version}</span>
          </div>
          <div className="h-px bg-[var(--border-subtle)]" />
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13px] text-[var(--fg-tertiary)]">Latest version</span>
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[13px] font-semibold text-foreground">v{update.version}</span>
              <span className="flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--status-running)_16%,transparent)] px-2.5 py-1 text-xs font-semibold text-[var(--status-running)]">
                <span className="size-1.5 rounded-full bg-[var(--status-running)]" />
                Update available
              </span>
            </div>
          </div>
        </div>

        {highlights.length > 0 && (
          <div className="flex flex-col gap-2.5">
            <span className="text-[13px] font-semibold text-foreground">What's new in v{update.version}</span>
            <ul className="flex flex-col gap-2">
              {highlights.map((h, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--status-running)]" />
                  <span className="text-[13px] leading-relaxed text-muted-foreground">{h}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <PrimaryButton
              onClick={update.canAutoInstall ? update.download : update.open}
              icon={<Download className="size-3.5" />}
            >
              {update.canAutoInstall ? "Update now" : "Download update"}
            </PrimaryButton>
            {update.releaseUrl && (
              <a
                href={update.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[13px] font-semibold text-[var(--accent-primary)] hover:underline"
              >
                Release notes
                <ArrowUpRight className="size-3.5" />
              </a>
            )}
          </div>
          {lastCheckedLabel && <span className="text-xs text-[var(--fg-tertiary)]">{lastCheckedLabel}</span>}
        </div>
      </div>
    );
  }

  // checking / idle → up to date (idle has no "not available" status; a completed
  // check with no update simply returns to idle).
  return (
    <div className="flex flex-wrap items-center gap-3.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-4">
      <div className="flex size-9 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--status-running)_16%,transparent)]">
        {update.status === "checking"
          ? <LoaderCircle className="size-[18px] animate-spin text-[var(--accent-primary)]" />
          : <Check className="size-[18px] text-[var(--status-running)]" />}
      </div>
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-foreground">
          {update.status === "checking" ? "Checking for updates…" : "You're up to date"}
        </span>
        <span className="text-[13px] text-[var(--fg-tertiary)]">
          {update.status === "checking"
            ? "Looking for a newer release."
            : version ? `Rigel v${version} is the latest version.` : "Rigel is the latest version."}
        </span>
      </div>
      {update.status !== "checking" && lastCheckedLabel && (
        <span className="text-xs text-[var(--fg-tertiary)]">{lastCheckedLabel}</span>
      )}
    </div>
  );
}

function StatusRow({
  tone,
  icon,
  children,
  className,
}: {
  tone: "running" | "pending";
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const bg = tone === "running"
    ? "bg-[color-mix(in_oklab,var(--status-running)_16%,transparent)]"
    : "bg-[color-mix(in_oklab,var(--status-pending)_16%,transparent)]";
  return (
    <div className={cn("flex items-center gap-3.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-4", className)}>
      <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", bg)}>{icon}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function PrimaryButton({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-2 rounded-md bg-[var(--accent-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--fg-inverse)] transition-opacity hover:opacity-90"
    >
      {icon}
      {children}
    </button>
  );
}
