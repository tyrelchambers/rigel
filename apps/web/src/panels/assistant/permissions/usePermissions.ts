// usePermissions — loads the persisted RbacPolicy (getRbac), holds a staged
// in-memory edit of it, diffs staged against applied, and applies staged via
// setRbac. The Simple and Advanced views are both controlled views over the
// same `staged` policy so switching sub-tabs never loses an edit.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_POLICY,
  diffPolicies,
  liveMatchesPolicy,
  parsePolicy,
  serializePolicy,
  setCapability,
  toggleCell as toggleCellInPolicy,
  type RbacPolicy,
} from "@rigel/k8s";
import { postAssistant, useAssistantAction } from "@/lib/api";

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
  const appliedRules = query.data?.appliedRules ?? null;
  const [staged, setStaged] = useState<RbacPolicy>(applied);

  // Seed `staged` from the fetched policy exactly once, so a background
  // refetch never clobbers an operator's in-progress edit.
  const seeded = useRef(false);
  useEffect(() => {
    if (query.data && !seeded.current) {
      setStaged(query.data.policy);
      seeded.current = true;
    }
  }, [query.data]);

  // The live ClusterRole differs from what the stored policy renders. Null live
  // rules (best-effort read failed) is never reported as drift.
  const drift = Array.isArray(appliedRules) && !liveMatchesPolicy(appliedRules, applied);

  function toggleCapability(id: string, on: boolean) {
    setStaged((p) => setCapability(p, id, on));
  }

  function toggleCell(cell: string, on: boolean) {
    setStaged((p) => toggleCellInPolicy(p, cell, on));
  }

  function push(policy: RbacPolicy, contexts: string[], onDone?: () => void) {
    action.mutate(
      { action: "setRbac", namespace, policy: serializePolicy(policy), contexts },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey });
          onDone?.();
        },
      },
    );
  }

  function apply(contexts: string[], onDone?: () => void) {
    push(staged, contexts, onDone);
  }

  function reapply(contexts: string[], onDone?: () => void) {
    push(applied, contexts, onDone);
  }

  return {
    applied,
    staged,
    diff: stagedDiff(applied, staged),
    drift,
    toggleCapability,
    toggleCell,
    apply,
    reapply,
    applying: action.isPending,
    applyError: action.error,
    loading: query.isLoading,
    loadError: query.error,
  };
}
