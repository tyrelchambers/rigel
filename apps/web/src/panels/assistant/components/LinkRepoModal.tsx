// LinkRepoModal — bind a project's running Deployment to a GitHub repo so the
// agent can open fix PRs against it. Reproduces the Pencil "Link to repo" modal
// (frame xSyQL): icon-tiled header with the deployment subtitle, intro, repo
// URL + branch + manifest-path fields, an accent note, and the primary action.
// Built on the shared Dialog primitive (graphite #101012 body, hairline ring,
// 16px radius all come from DialogContent).

import { useEffect, useState } from "react";
import { GitBranch, Info, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLinkRepo } from "@/panels/gitops/gitApi";

const FIELD_INPUT =
  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5 font-mono text-xs text-[var(--fg-primary)] outline-none transition-colors placeholder:text-[var(--fg-tertiary)] focus:border-[var(--accent-primary)]";

function ModalField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-1 flex-col gap-2">
      <span className="text-xs font-medium text-[var(--fg-secondary)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={FIELD_INPUT}
      />
    </label>
  );
}

export function LinkRepoModal({
  open,
  onOpenChange,
  namespace,
  deployment,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  namespace: string;
  deployment: string;
  /** Called after the repo is linked successfully (before the modal closes), so
   *  the caller can opt the now-linked project into autofix scope. */
  onLinked?: () => void;
}) {
  const link = useLinkRepo();
  const [repoURL, setRepoURL] = useState("");
  const [branch, setBranch] = useState("main");
  const [path, setPath] = useState("");

  // Reset the form each time the modal opens for a (possibly different) project.
  useEffect(() => {
    if (open) {
      setRepoURL("");
      setBranch("main");
      setPath("");
      link.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deployment, namespace]);

  const canSubmit = repoURL.trim() !== "" && !link.isPending;

  function submit() {
    if (!canSubmit) return;
    link.mutate(
      {
        namespace,
        deployment,
        repoURL: repoURL.trim(),
        branch: branch.trim() || undefined,
        path: path.trim() || undefined,
      },
      {
        onSuccess: () => {
          onLinked?.();
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-[540px] flex-col gap-0 overflow-hidden p-0"
      >
        {/* Header — icon tile + title/subtitle + close, hairline-separated */}
        <div className="flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-[22px] py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.07]">
              <GitBranch className="size-4 text-[var(--accent-primary)]" />
            </div>
            <div className="flex flex-col gap-1">
              <DialogTitle className="font-sans text-base font-semibold text-[var(--fg-primary)]">
                Link to repo
              </DialogTitle>
              <p className="text-xs text-[var(--fg-tertiary)]">
                {deployment} · creates a GitOps source
              </p>
            </div>
          </div>
          <DialogClose
            className="flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.05]"
            aria-label="Close"
          >
            <X className="size-[18px] text-[var(--fg-tertiary)]" />
          </DialogClose>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 px-[22px] py-[22px]">
          <p className="text-[13px] leading-[1.5] text-[var(--fg-secondary)]">
            Point Rigel at this project's GitHub repo. It creates a GitOps source (the repo mapping)
            and stamps the deployment so it can open fix PRs. It won't deploy from the repo unless
            you set that up separately.
          </p>

          <ModalField
            label="Repository URL"
            value={repoURL}
            onChange={setRepoURL}
            placeholder="https://github.com/owner/repo"
          />

          <div className="flex gap-3">
            <ModalField label="Branch" value={branch} onChange={setBranch} placeholder="main" />
            <ModalField
              label="Manifest path (optional)"
              value={path}
              onChange={setPath}
              placeholder="k8s/"
            />
          </div>

          <div className="flex items-center gap-2 rounded-lg bg-[var(--accent-dim)] px-3 py-2.5">
            <Info className="size-3.5 shrink-0 text-[var(--accent-primary)]" />
            <span className="text-[11px] text-[var(--fg-secondary)]">
              Writes a rigel-git-sources entry and annotates the live deployment. No redeploy.
            </span>
          </div>

          {link.error && (
            <p className="font-mono text-[11px] text-[var(--status-failed)]">
              {link.error.message}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-[22px] pb-[18px] pt-2.5">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-[9px] px-3 py-2.5 text-[13px] font-medium text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-[9px] bg-[var(--accent-primary)] px-[18px] py-2.5 text-sm font-semibold text-[var(--fg-inverse)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <GitBranch className="size-4" />
            {link.isPending ? "Linking…" : "Create source & link"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
