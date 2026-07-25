import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCube, faCloud, faFileLines, faArrowLeft, faCheck } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useContexts } from "@/lib/api";
import { CreateClusterBody } from "../CreateClusterBody";
import { ConnectClusterBody } from "../ConnectClusterBody";
import { ImportKubeconfigPanel } from "../ImportKubeconfigPanel";
import { OptionCard } from "./OptionCard";

type Path = "create" | "connect" | "import" | null;

const PATHS: { id: Exclude<Path, null>; icon: typeof faCube; title: string; desc: string; hero?: boolean }[] = [
  {
    id: "create",
    icon: faCube,
    title: "Create a local cluster",
    desc: "Spin up a kind or k3d cluster on your machine in about a minute. Perfect for trying Rigel, and it just needs Docker.",
    hero: true,
  },
  {
    id: "connect",
    icon: faCloud,
    title: "Connect a cloud cluster",
    desc: "Already running on EKS, GKE, AKS, or DigitalOcean? Connect it with your provider login.",
  },
  {
    id: "import",
    icon: faFileLines,
    title: "Import a kubeconfig",
    desc: "Paste a kubeconfig a teammate already shared with you.",
  },
];

/** Onboarding step 1. The chosen flow renders inline, replacing the card list,
 *  so nothing stacks a dialog on top of the wizard. */
export function ClusterStep() {
  const [path, setPath] = useState<Path>(null);
  const { data: contexts } = useContexts();
  const context = contexts?.find((c) => c.active) ?? contexts?.[0];

  if (path) {
    return (
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => setPath(null)}
          className="flex items-center gap-2 self-start text-xs font-semibold text-[var(--accent-primary)]"
        >
          <FontAwesomeIcon icon={faArrowLeft} className="size-3" />
          All connection options
        </button>
        {path === "create" && <CreateClusterBody active onDone={() => setPath(null)} />}
        {path === "connect" && <ConnectClusterBody active onDone={() => setPath(null)} />}
        {path === "import" && <ImportKubeconfigPanel onDone={() => setPath(null)} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {context && (
        <span className="flex items-center gap-2 self-start rounded-full border border-[color-mix(in_oklab,var(--status-running)_40%,transparent)] bg-[color-mix(in_oklab,var(--status-running)_10%,transparent)] px-3 py-1">
          <FontAwesomeIcon icon={faCheck} className="size-3 text-[var(--status-running)]" />
          <span className="text-xs font-semibold text-[var(--status-running)]">Connected: {context.name}</span>
        </span>
      )}
      {PATHS.map((p) => (
        <OptionCard
          key={p.id}
          hero={p.hero}
          icon={<FontAwesomeIcon icon={p.icon} className="size-5" />}
          title={p.title}
          desc={p.desc}
          onClick={() => setPath(p.id)}
        />
      ))}
    </div>
  );
}
