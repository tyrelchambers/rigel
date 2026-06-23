// OwnedResources — the Overview "Resources" card: every Kubernetes object the
// assistant install owns, grouped, each linking to its panel scoped to the agent's
// namespace (the panels are list views — there's no per-resource route — so a link
// opens the panel + sets the shared namespace filter). Built to Pencil frame
// "Assistant — Owned resources card".
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router";
import { useCluster } from "@/store/cluster";
import { useAssistantCtx } from "./AssistantContext";
import { Card, Section } from "./components/primitives";

interface OwnedResource {
  kind: string;
  name: string;
  /** Destination list panel. */
  route: string;
  /** Namespaced objects scope the panel to the agent ns; cluster-scoped clear it. */
  namespaced: boolean;
}
interface ResourceGroup {
  title: string;
  items: OwnedResource[];
}

/** The fixed set of objects the installer creates (see packages/k8s assistant
 *  manifests). `podName` is the live agent pod when present. */
function inventory(podName: string | undefined): ResourceGroup[] {
  return [
    {
      title: "Workload",
      items: [
        { kind: "Deployment", name: "rigel-assistant", route: "/deployments", namespaced: true },
        ...(podName ? [{ kind: "Pod", name: podName, route: "/pods", namespaced: true }] : []),
      ],
    },
    {
      title: "Config & state",
      items: [
        { kind: "ConfigMap", name: "assistant-config", route: "/configmaps", namespaced: true },
        { kind: "ConfigMap", name: "assistant-state", route: "/configmaps", namespaced: true },
        { kind: "ConfigMap", name: "assistant-backups", route: "/configmaps", namespaced: true },
      ],
    },
    {
      title: "Credentials",
      items: [
        { kind: "Secret", name: "rigel-assistant-token", route: "/secrets", namespaced: true },
        { kind: "Secret", name: "rigel-assistant-credentials", route: "/secrets", namespaced: true },
      ],
    },
    {
      title: "Access (RBAC)",
      items: [
        { kind: "ServiceAccount", name: "rigel-assistant", route: "/rbac", namespaced: true },
        { kind: "ClusterRole", name: "rigel-assistant", route: "/rbac", namespaced: false },
        { kind: "ClusterRoleBinding", name: "rigel-assistant", route: "/rbac", namespaced: false },
      ],
    },
  ];
}

export function OwnedResources() {
  const { d } = useAssistantCtx();
  const navigate = useNavigate();
  const setNamespaceFilter = useCluster((s) => s.setNamespaceFilter);

  if (!d.isInstalled || !d.installedNamespace) return null;
  const ns = d.installedNamespace;
  const groups = inventory(d.agentPod?.metadata.name);

  function open(r: OwnedResource) {
    // Scope the destination panel so the owned object is visible; cluster-scoped
    // objects (ClusterRole/Binding) clear the filter (null = all namespaces).
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
