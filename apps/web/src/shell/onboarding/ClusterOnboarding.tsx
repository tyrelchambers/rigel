import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCube, faCloud, faFileLines, faChevronRight, faSparkles } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { CreateClusterModal } from "../CreateClusterModal";
import { ConnectClusterModal } from "../ConnectClusterModal";
import { ImportKubeconfigPanel } from "../ImportKubeconfigPanel";

type OpenPath = "create" | "connect" | "import" | null;

function OptionCard({
  icon,
  title,
  desc,
  hero,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  hero?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-colors",
        hero
          ? "border-[color-mix(in_oklab,var(--accent-primary)_35%,transparent)] bg-[var(--accent-dim)] hover:bg-[color-mix(in_oklab,var(--accent-primary)_22%,transparent)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:bg-white/[0.04]",
      )}
    >
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-lg",
          hero ? "bg-[var(--accent-dim)] text-[var(--accent-primary)]" : "bg-white/[0.06] text-[var(--fg-secondary)]",
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--fg-primary)]">{title}</span>
          {hero && (
            <span className="rounded-full border border-[color-mix(in_oklab,var(--accent-primary)_40%,transparent)] px-2 py-0.5 font-mono text-3xs font-semibold tracking-widest text-[var(--accent-primary)]">
              RECOMMENDED
            </span>
          )}
        </span>
        <span className="text-xs text-[var(--fg-secondary)]">{desc}</span>
      </span>
      <FontAwesomeIcon icon={faChevronRight} className="size-4 shrink-0 text-[var(--fg-tertiary)]" />
    </button>
  );
}

export function ClusterOnboarding({ onSkip }: { onSkip: () => void }) {
  const [open, setOpen] = useState<OpenPath>(null);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[var(--surface-sunken)] px-4 py-10">
      <div className="flex w-full max-w-[560px] flex-col items-center gap-8">
        <div className="flex w-full flex-col items-start gap-3 text-left">
          <h1 className="flex items-start gap-3 text-5xl font-semibold leading-[1.05] text-[var(--fg-primary)]">
            <FontAwesomeIcon icon={faSparkles} className="mt-1 size-9 shrink-0 text-[var(--accent-primary)]" />
            <span>Hey, welcome to Rigel</span>
          </h1>
          <p className="w-full text-sm text-[var(--fg-secondary)]">
            Rigel is a desktop app for your Kubernetes clusters. Connect your first one below to see
            what&apos;s running, fix what&apos;s broken, and get AI help when you need it. We&apos;re glad
            you&apos;re here.
          </p>
        </div>

        <div className="flex w-full flex-col gap-3">
          <OptionCard
            hero
            icon={<FontAwesomeIcon icon={faCube} className="size-5" />}
            title="Create a local cluster"
            desc="Spin up a kind or k3d cluster on your machine in about a minute. Perfect for trying Rigel — just needs Docker."
            onClick={() => setOpen("create")}
          />
          <OptionCard
            icon={<FontAwesomeIcon icon={faCloud} className="size-5" />}
            title="Connect a cloud cluster"
            desc="Already running on EKS, GKE, AKS, or DigitalOcean? Connect it with your provider login."
            onClick={() => setOpen("connect")}
          />
          <OptionCard
            icon={<FontAwesomeIcon icon={faFileLines} className="size-5" />}
            title="Import a kubeconfig"
            desc="Paste a kubeconfig a teammate already shared with you."
            onClick={() => setOpen("import")}
          />
        </div>

        <Button variant="ghost" size="sm" onClick={onSkip}>
          Skip for now
        </Button>
      </div>

      <CreateClusterModal open={open === "create"} onOpenChange={(o) => !o && setOpen(null)} />
      <ConnectClusterModal open={open === "connect"} onOpenChange={(o) => !o && setOpen(null)} />
      <Dialog open={open === "import"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogIcon>
              <FontAwesomeIcon icon={faFileLines} className="size-[17px]" />
            </DialogIcon>
            <DialogTitle>Import a kubeconfig</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <ImportKubeconfigPanel onDone={() => setOpen(null)} />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
