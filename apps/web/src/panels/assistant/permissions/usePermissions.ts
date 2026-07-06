// usePermissions — loads the persisted RbacPolicy (getRbac), holds a staged
// in-memory edit of it, diffs staged against applied, and applies staged via
// setRbac. The Simple and Advanced views are both controlled views over the
// same `staged` policy so switching sub-tabs never loses an edit.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_POLICY,
  diffPolicies,
  parsePolicy,
  serializePolicy,
  setCapability,
  toggleCell as toggleCellInPolicy,
  type RbacPolicy,
} from "@rigel/k8s";
import { postAssistant, useAssistantAction } from "@/lib/api";

export type RbacTarget = "active" | "all";

/** Pure: pending-change summary between the applied and staged policy. */
export function stagedDiff(applied: RbacPolicy, staged: RbacPolicy) {
  const diff = diffPolicies(applied, staged);
  return { ...diff, count: diff.added.length + diff.removed.length };
}

interface RbacQueryData {
  policy: RbacPolicy;
  appliedRules: unknown;
}

async function fetchRbac(namespace: string): Promise<RbacQueryData> {
  const res = await postAssistant({ action: "getRbac", namespace });
  const parsed = JSON.parse(res.stdout || "{}") as { policy?: string; appliedRules?: unknown };
  return { policy: parsePolicy(parsed.policy), appliedRules: parsed.appliedRules ?? null };
}

export function usePermissions(namespace: string) {
  const queryKey = ["assistant-rbac", namespace] as const;
  const query = useQuery({ queryKey, queryFn: () => fetchRbac(namespace) });
  const qc = useQueryClient();
  const action = useAssistantAction();

  const applied = query.data?.policy ?? DEFAULT_POLICY;
  const [staged, setStaged] = useState<RbacPolicy>(applied);
  const [target, setTarget] = useState<RbacTarget>("active");

  // Seed `staged` from the fetched policy exactly once, so a background
  // refetch never clobbers an operator's in-progress edit.
  const seeded = useRef(false);
  useEffect(() => {
    if (query.data && !seeded.current) {
      setStaged(query.data.policy);
      seeded.current = true;
    }
  }, [query.data]);

  function toggleCapability(id: string, on: boolean) {
    setStaged((p) => setCapability(p, id, on));
  }

  function toggleCell(cell: string, on: boolean) {
    setStaged((p) => toggleCellInPolicy(p, cell, on));
  }

  function apply(onDone?: () => void) {
    action.mutate(
      { action: "setRbac", namespace, policy: serializePolicy(staged), rbacTarget: target },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey });
          onDone?.();
        },
      },
    );
  }

  return {
    applied,
    staged,
    diff: stagedDiff(applied, staged),
    target,
    setTarget,
    toggleCapability,
    toggleCell,
    apply,
    applying: action.isPending,
    applyError: action.error,
    loading: query.isLoading,
    loadError: query.error,
  };
}
