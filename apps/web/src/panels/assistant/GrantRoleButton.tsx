import { useCallback, useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faShieldPlus } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import type { ActionBlock } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import {
  BindingEditor,
  type BindingTarget,
  type RoleOption,
} from "@/panels/rbac/components/BindingEditor";
import type { ClusterRole, Role } from "@/panels/rbac/types";

function values<T>(rec: Record<string, T> | undefined): T[] {
  return Object.values(rec ?? {});
}

interface Props {
  /** The assistant's install namespace — where its ServiceAccount lives. */
  namespace: string;
}

/**
 * "Grant a role" — opens the RBAC BindingEditor pre-seeded with the assistant's
 * `rigel-assistant` ServiceAccount so the user can bind it to a chosen
 * Role/ClusterRole. Applies through the same guarded applyManifest → ConfirmSheet
 * path as every other RBAC write.
 */
export function GrantRoleButton({ namespace }: Props) {
  const resources = useCluster((s) => s.resources);
  const [open, setOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);

  // The roleRef dropdown needs the cluster's roles/clusterroles — own the watch
  // while the editor is open so it works even if the RBAC panel was never opened.
  useEffect(() => {
    if (!open) return;
    subscribe("roles", "*");
    subscribe("clusterroles", "*");
    return () => {
      unsubscribe("roles", "*");
      unsubscribe("clusterroles", "*");
    };
  }, [open]);

  const roleOptions: RoleOption[] = useMemo(
    () => [
      ...values<Role>(resources["roles"] as Record<string, Role>).map((r) => ({
        kind: "Role" as const,
        name: r.metadata.name,
        namespace: r.metadata.namespace,
      })),
      ...values<ClusterRole>(resources["clusterroles"] as Record<string, ClusterRole>).map((r) => ({
        kind: "ClusterRole" as const,
        name: r.metadata.name,
      })),
    ],
    [resources],
  );

  // Suggest a binding name from the chosen role, sanitised to a valid k8s name
  // (role names like "system:controller:foo" contain colons that aren't allowed).
  const nameSuggestion = useCallback(
    (roleName: string) =>
      roleName
        ? `rigel-assistant-${roleName}`
            .toLowerCase()
            .replace(/[^a-z0-9.-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 253)
        : "",
    [],
  );

  const target: BindingTarget = useMemo(
    () => ({
      kind: "ClusterRoleBinding",
      name: "",
      roleRef: { kind: "ClusterRole", name: "" },
      subjects: [{ kind: "ServiceAccount", name: "rigel-assistant", namespace }],
    }),
    [namespace],
  );

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <FontAwesomeIcon icon={faShieldPlus} className="size-3.5" />
        Grant a role
      </Button>
      {open && (
        <BindingEditor
          target={target}
          open
          roleOptions={roleOptions}
          nameSuggestion={nameSuggestion}
          onClose={() => setOpen(false)}
          onApply={(result) => {
            setOpen(false);
            setPendingAction({ kind: "applyManifest", label: result.label, manifest: result.yaml });
          }}
        />
      )}
      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </>
  );
}
