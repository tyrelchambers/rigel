// Names the Secret a settings section reads and writes, and says so loudly when
// that cluster could not be reached. Every section backed by rigel-user-config
// says the same thing, so they say it in the same words from here.
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { ClusterConfigStatus } from "@/lib/api";

/** True when there is nowhere to read from or save to, so a form must lock. */
export function clusterLocked(cluster: ClusterConfigStatus | undefined): boolean {
  return cluster?.state === "unavailable";
}

export function ClusterConfigNote({ cluster }: { cluster: ClusterConfigStatus }) {
  const clusterName = cluster.context ?? "the current kubeconfig context";
  if (clusterLocked(cluster)) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground">
        <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 size-3.5 text-destructive" />
        <span>
          These settings live in the <span className="font-mono">{cluster.secret}</span> Secret on{" "}
          <span className="font-medium">{clusterName}</span>, which could not be reached, so nothing
          can be read or saved here. Connect a cluster and reopen this page.
          {cluster.message && (
            <span className="mt-1 block font-mono text-2xs text-muted-foreground">
              {cluster.message}
            </span>
          )}
        </span>
      </div>
    );
  }
  return (
    <p className="text-xs leading-snug text-muted-foreground">
      Saved in the <span className="font-mono">{cluster.secret}</span> Secret in the{" "}
      <span className="font-mono">{cluster.namespace}</span> namespace on{" "}
      <span className="font-medium">{clusterName}</span>. Each cluster keeps its own, and nothing is
      written to this machine.
    </p>
  );
}
