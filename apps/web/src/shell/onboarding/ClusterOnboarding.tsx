import { useState } from "react";
import { Box, Cloud, FileText, ChevronRight } from "lucide-react";
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
      <ChevronRight className="size-4 shrink-0 text-[var(--fg-tertiary)]" />
    </button>
  );
}

export function ClusterOnboarding({ onSkip }: { onSkip: () => void }) {
  const [open, setOpen] = useState<OpenPath>(null);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[var(--surface-sunken)] px-4 py-10">
      <div className="flex w-full max-w-[560px] flex-col items-center gap-8">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-primary" />
          <span className="font-mono text-2xs font-semibold tracking-widest text-[var(--fg-secondary)]">RIGEL</span>
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-semibold text-[var(--fg-primary)]">Connect a cluster to get started</h1>
          <p className="text-sm text-[var(--fg-secondary)]">
            Rigel works with any Kubernetes cluster. Pick how you&apos;d like to connect — you can add more anytime.
          </p>
        </div>

        <div className="flex w-full flex-col gap-3">
          <OptionCard
            hero
            icon={<Box className="size-5" />}
            title="Create a local cluster"
            desc="Spin up a kind or k3d cluster on your machine in about a minute. Perfect for trying Rigel — just needs Docker."
            onClick={() => setOpen("create")}
          />
          <OptionCard
            icon={<Cloud className="size-5" />}
            title="Connect a cloud cluster"
            desc="Already running on EKS, GKE, AKS, or DigitalOcean? Connect it with your provider login."
            onClick={() => setOpen("connect")}
          />
          <OptionCard
            icon={<FileText className="size-5" />}
            title="Import a kubeconfig"
            desc="Paste a kubeconfig a teammate already shared with you."
            onClick={() => setOpen("import")}
          />
        </div>

        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-xs text-[var(--fg-tertiary)]">
            New to Kubernetes?{" "}
            <a
              href="https://kubernetes.io/docs/tutorials/kubernetes-basics/"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent-primary)] hover:underline"
            >
              Learn the basics
            </a>
          </p>
          <Button variant="ghost" size="sm" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </div>

      <CreateClusterModal open={open === "create"} onOpenChange={(o) => !o && setOpen(null)} />
      <ConnectClusterModal open={open === "connect"} onOpenChange={(o) => !o && setOpen(null)} />
      <Dialog open={open === "import"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogIcon>
              <FileText className="size-[17px]" />
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
