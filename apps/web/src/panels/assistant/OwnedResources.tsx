// OwnedResources — the Overview "Resources" card: every Kubernetes object the
// assistant install owns, grouped, each with a LIVE presence dot and a link to its
// panel scoped to the agent's namespace (the panels are list views — no per-resource
// route — so a link opens the panel + sets the shared namespace filter). Presence
// comes from the cluster store: the core kinds are already watched by useAssistant;
// this component additionally watches the RBAC kinds while the tab is open. Built to
// Pencil frame "Assistant — Owned resources card".
import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { useAssistantCtx } from "./AssistantContext";
import { Card, Section } from "./components/primitives";

interface OwnedResource {
  kind: string;
  /** The store/watch kind (plural) this object is keyed under. */
  storeKind: string;
  name: string;
  /** Destination list panel. */
  route: string;
  /** Namespaced objects key by `<ns>/<name>` and scope the panel; cluster-scoped
   *  objects key by bare name and clear the namespace filter. */
  namespaced: boolean;
}
interface ResourceGroup {
  title: string;
  items: OwnedResource[];
}

type Presence = "present" | "missing" | "checking";

/** The fixed set of objects the installer creates (see packages/k8s assistant
 *  manifests). `podName` is the live agent pod when present. */
function inventory(podName: string | undefined): ResourceGroup[] {
  return [
    {
      title: "Workload",
      items: [
        { kind: "Deployment", storeKind: "deployments", name: "rigel-assistant", route: "/deployments", namespaced: true },
        ...(podName
          ? [{ kind: "Pod", storeKind: "pods", name: podName, route: "/pods", namespaced: true }]
          : []),
      ],
    },
    {
      title: "Config & state",
      items: [
        { kind: "ConfigMap", storeKind: "configmaps", name: "assistant-config", route: "/configmaps", namespaced: true },
        { kind: "ConfigMap", storeKind: "configmaps", name: "assistant-state", route: "/configmaps", namespaced: true },
        { kind: "ConfigMap", storeKind: "configmaps", name: "assistant-backups", route: "/configmaps", namespaced: true },
      ],
    },
    {
      title: "Credentials",
      items: [
        { kind: "Secret", storeKind: "secrets", name: "rigel-assistant-token", route: "/secrets", namespaced: true },
        { kind: "Secret", storeKind: "secrets", name: "rigel-assistant-credentials", route: "/secrets", namespaced: true },
      ],
    },
    {
      title: "Access (RBAC)",
      items: [
        { kind: "ServiceAccount", storeKind: "serviceaccounts", name: "rigel-assistant", route: "/rbac", namespaced: true },
        { kind: "ClusterRole", storeKind: "clusterroles", name: "rigel-assistant", route: "/rbac", namespaced: false },
        { kind: "ClusterRoleBinding", storeKind: "clusterrolebindings", name: "rigel-assistant", route: "/rbac", namespaced: false },
      ],
    },
  ];
}

export function OwnedResources() {
  const { d } = useAssistantCtx();
  const navigate = useNavigate();
  const setNamespaceFilter = useCluster((s) => s.setNamespaceFilter);
  const resources = useCluster((s) => s.resources);

  const installed = d.isInstalled && !!d.installedNamespace;
  const ns = d.installedNamespace ?? "";

  // useAssistant already watches deployments/pods/configmaps/secrets; add the RBAC
  // kinds (only while this card is shown) so every row gets a live presence dot.
  useEffect(() => {
    if (!installed) return;
    subscribe("serviceaccounts", ns);
    subscribe("clusterroles", "*");
    subscribe("clusterrolebindings", "*");
    return () => {
      unsubscribe("serviceaccounts", ns);
      unsubscribe("clusterroles", "*");
      unsubscribe("clusterrolebindings", "*");
    };
  }, [installed, ns]);

  if (!installed) return null;
  const groups = inventory(d.agentPod?.metadata.name);

  function presenceOf(r: OwnedResource): Presence {
    const slice = resources[r.storeKind];
    const key = r.namespaced ? `${ns}/${r.name}` : r.name;
    if (slice && key in slice) return "present";
    // A loaded-but-absent kind means genuinely missing; an empty/undefined slice
    // means the watch hasn't delivered yet.
    if (slice && Object.keys(slice).length > 0) return "missing";
    return "checking";
  }

  function open(r: OwnedResource) {
    setNamespaceFilter(r.namespaced ? ns : null);
    navigate(r.route);
  }

  return (
    <Section title="Resources">
      <Card className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Kubernetes objects this assistant owns in <span className="font-mono">{ns}</span>. Open one
          to view it in its panel.
        </p>
        {groups.map((g) => (
          <div key={g.title} className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {g.title}
            </p>
            <div className="space-y-1.5">
              {g.items.map((r) => (
                <button
                  key={`${r.kind}/${r.name}`}
                  type="button"
                  onClick={() => open(r)}
                  aria-label={`Open ${r.kind} ${r.name}`}
                  className="flex w-full items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-left transition-colors hover:bg-muted"
                >
                  <PresenceDot state={presenceOf(r)} />
                  <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {r.kind}
                  </span>
                  <span className="truncate font-mono text-xs">{r.name}</span>
                  <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        ))}
      </Card>
    </Section>
  );
}

function PresenceDot({ state }: { state: Presence }) {
  const meta: Record<Presence, { cls: string; label: string }> = {
    present: { cls: "bg-green-500", label: "Present" },
    missing: { cls: "bg-red-500", label: "Missing" },
    checking: { cls: "bg-muted-foreground/40 animate-pulse", label: "Checking…" },
  };
  const { cls, label } = meta[state];
  return (
    <span role="img" aria-label={label} title={label} className={`size-2 shrink-0 rounded-full ${cls}`} />
  );
}
