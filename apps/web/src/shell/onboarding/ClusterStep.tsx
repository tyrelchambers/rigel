import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCube, faCloud, faFileLines, faCheck } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useContexts, useClusterTools } from "@/lib/api";
import { CreateClusterBody, clusterToolsReady } from "../CreateClusterBody";
import { ConnectClusterBody } from "../ConnectClusterBody";
import { ImportKubeconfigPanel } from "../ImportKubeconfigPanel";
import { OptionCard } from "./OptionCard";
import { SubflowHead } from "./SubflowHead";
import { useWizardHost } from "./wizardHost";

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

/** The create flow explains two different things depending on what it finds on
 *  the machine, so the head says which one the user is looking at. */
const CREATE_READY =
  "Rigel runs the create for you and adds the new context to your kubeconfig. Takes about a minute.";
const CREATE_SETUP =
  "This runs a real Kubernetes cluster on your machine inside Docker, using kind or k3d. You need one of them installed, plus Docker running.";

const HEADS: Record<Exclude<Path, null>, string> = {
  create: "Create a local cluster",
  connect: "Connect a cloud cluster",
  import: "Import a kubeconfig",
};

/** Onboarding step 1. The chosen flow renders inline, replacing the card list,
 *  so nothing stacks a dialog on top of the wizard. */
export function ClusterStep() {
  const [path, setPath] = useState<Path>(null);
  const { data: contexts } = useContexts();
  const { data: tools } = useClusterTools();
  const host = useWizardHost();
  const context = contexts?.find((c) => c.active) ?? contexts?.[0];

  // Reads the same cached query the create body does, so the head can name the
  // state without the body having to report it upwards.
  const setSubflow = host?.setSubflow;
  useEffect(
    // Create and import each end in one action, so they take the footer. The
    // cloud connect flow has a button per step of its own and takes only the head.
    () => setSubflow?.(path !== null, path === "create" || path === "import"),
    [setSubflow, path],
  );

  if (path) {
    const back = () => setPath(null);
    const description =
      path === "create"
        ? clusterToolsReady(tools)
          ? CREATE_READY
          : CREATE_SETUP
        : path === "connect"
          ? "Pick your provider and sign in, and Rigel adds the cluster to your kubeconfig."
          : "Paste a kubeconfig a teammate already shared with you.";
    return (
      <div className="flex flex-col gap-5">
        <SubflowHead title={HEADS[path]} description={description} onBack={back} />
        {path === "create" && <CreateClusterBody active onDone={back} />}
        {path === "connect" && <ConnectClusterBody active onDone={back} />}
        {path === "import" && <ImportKubeconfigPanel onDone={back} />}
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
