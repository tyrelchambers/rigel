// OwnedResources — the Overview "Resources" section: every Kubernetes object the
// assistant install owns, grouped into two columns, each row with a LIVE presence
// dot, a colour-coded kind badge, and a link to its panel scoped to the agent's
// namespace (the panels are list views — no per-resource route — so a link opens
// the panel + sets the shared namespace filter). Presence comes from the cluster
// store: the core kinds are already watched by useAssistant; this component
// additionally watches the RBAC kinds while the tab is open. Built to Pencil frame
// "Assistant — Overview (improved)" (Resources block).
import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { useAssistantCtx } from "./AssistantContext";

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

/** Titles that live in the left column; the rest fall to the right column. */
const LEFT_COLUMN = new Set(["Workload", "Config & state"]);

/** Colour-coded kind badge — accent for workload, purple for RBAC, amber for
 *  credentials, neutral for config/state. Mirrors the Pencil badge palette. */
function kindBadgeClass(kind: string): string {
  switch (kind) {
    case "Deployment":
    case "Pod":
      return "bg-[rgba(56,189,248,0.12)] text-[var(--accent-primary)]";
    case "ServiceAccount":
    case "ClusterRole":
    case "ClusterRoleBinding":
      return "bg-[rgba(168,85,247,0.12)] text-[#c084fc]";
    case "Secret":
      return "bg-[rgba(245,158,11,0.12)] text-[var(--status-pending)]";
    default:
      return "bg-white/[0.07] text-[var(--fg-secondary)]";
  }
}

/** The fixed set of objects the installer creates (see packages/k8s assistant
 *  manifests). `podName` is the live agent pod when present. Ordered so the two
 *  columns read Workload / Config & state | Access (RBAC) / Credentials. */
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
      title: "Access (RBAC)",
      items: [
        { kind: "ServiceAccount", storeKind: "serviceaccounts", name: "rigel-assistant", route: "/rbac", namespaced: true },
        { kind: "ClusterRole", storeKind: "clusterroles", name: "rigel-assistant", route: "/rbac", namespaced: false },
        { kind: "ClusterRoleBinding", storeKind: "clusterrolebindings", name: "rigel-assistant", route: "/rbac", namespaced: false },
      ],
    },
    {
      title: "Credentials",
      items: [
        { kind: "Secret", storeKind: "secrets", name: "rigel-assistant-token", route: "/secrets", namespaced: true },
        { kind: "Secret", storeKind: "secrets", name: "rigel-assistant-credentials", route: "/secrets", namespaced: true },
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

  // For Credentials, only surface Secrets that actually exist: a "missing"
  // credential is ambiguous (a provider you simply aren't using has no Secret),
  // so hide it rather than flag it red. Other groups still show genuine gaps.
  const groups = inventory(d.agentPod?.metadata.name)
    .map((g) =>
      g.title === "Credentials"
        ? { ...g, items: g.items.filter((r) => presenceOf(r) === "present") }
        : g,
    )
    .filter((g) => g.items.length > 0);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const leftGroups = groups.filter((g) => LEFT_COLUMN.has(g.title));
  const rightGroups = groups.filter((g) => !LEFT_COLUMN.has(g.title));

  function renderGroup(g: ResourceGroup) {
    return (
      <div key={g.title} className="flex flex-col gap-2.5">
        <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[var(--fg-tertiary)]">
          <span>{g.title}</span>
          <span>· {g.items.length}</span>
        </div>
        <div className="flex flex-col gap-2">
          {g.items.map((r) => (
            <button
              key={`${r.kind}/${r.name}`}
              type="button"
              onClick={() => open(r)}
              aria-label={`Open ${r.kind} ${r.name}`}
              className="flex w-full items-center gap-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3 py-2.5 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-white/[0.02]"
            >
              <PresenceDot state={presenceOf(r)} />
              <span
                className={`shrink-0 rounded-sm px-2 py-[3px] font-mono text-[11px] font-medium ${kindBadgeClass(r.kind)}`}
              >
                {r.kind}
              </span>
              <span className="truncate font-mono text-[13px] text-[var(--fg-primary)]">{r.name}</span>
              <ArrowUpRight className="ml-auto size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[var(--fg-primary)]">Resources</h3>
        <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-2 py-0.5 font-mono text-xs font-semibold text-[var(--fg-secondary)]">
          {total}
        </span>
      </div>
      <p className="text-[13px] text-[var(--fg-tertiary)]">
        Kubernetes objects this assistant owns in <span className="font-mono">{ns}</span>. Open one to
        view it in its panel.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-[18px]">{leftGroups.map(renderGroup)}</div>
        <div className="flex flex-col gap-[18px]">{rightGroups.map(renderGroup)}</div>
      </div>
    </section>
  );
}

function PresenceDot({ state }: { state: Presence }) {
  const meta: Record<Presence, { cls: string; label: string }> = {
    present: { cls: "bg-[var(--status-running)]", label: "Present" },
    missing: { cls: "bg-[var(--status-failed)]", label: "Missing" },
    checking: { cls: "bg-[var(--fg-tertiary)] animate-pulse", label: "Checking…" },
  };
  const { cls, label } = meta[state];
  return (
    <span role="img" aria-label={label} title={label} className={`size-[7px] shrink-0 rounded-full ${cls}`} />
  );
}
