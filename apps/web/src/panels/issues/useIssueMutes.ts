import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clearMute, setMute, type IssueMutes } from "@rigel/k8s/src/issues/mutes";
import { apiFetch } from "@/lib/api";
import { useCluster } from "@/store/cluster";

const EMPTY: IssueMutes = {};

async function req(init?: RequestInit): Promise<IssueMutes> {
  const res = await apiFetch("/api/issues/config", init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  const body = (await res.json()) as { mutes?: IssueMutes };
  return body.mutes ?? EMPTY;
}

export interface UseIssueMutesResult {
  mutes: IssueMutes;
  mute: (fingerprint: string, snooze: { hours: number } | null) => void;
  unmute: (fingerprint: string) => void;
  saving: boolean;
}

/** This cluster's issue mutes, and the two edits the panel offers. The whole map
 *  is written back on every edit, so a clear cannot be resurrected by a merge. */
export function useIssueMutes(): UseIssueMutesResult {
  const activeContext = useCluster((s) => s.activeContext);
  const queryKey = [activeContext, "issue-mutes"] as const;
  const qc = useQueryClient();
  const query = useQuery({ queryKey, queryFn: () => req() });

  const save = useMutation({
    mutationFn: (mutes: IssueMutes) =>
      req({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutes }),
      }),
    onSuccess: (mutes) => qc.setQueryData(queryKey, mutes),
  });

  const mutes = query.data ?? EMPTY;

  return {
    mutes,
    mute: (fingerprint, snooze) => save.mutate(setMute(mutes, fingerprint, snooze)),
    unmute: (fingerprint) => save.mutate(clearMute(mutes, fingerprint)),
    saving: save.isPending,
  };
}
