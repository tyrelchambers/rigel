import { useQuery } from "@tanstack/react-query";

type Health = { ok: boolean; kubeconfig: string };

async function fetchHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json();
}

export default function HealthPanel() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5_000,
    staleTime: 0,
    gcTime: 0,
  });

  const reachable = !isPending && !isError && data?.ok === true;
  const dotColor = isPending ? "#9ca3af" : reachable ? "#22c55e" : "#ef4444";
  const label = isPending ? "checking…" : reachable ? "reachable" : "unreachable";
  const tooltip = isError ? (error as Error).message : undefined;

  return (
    <div className="inline-flex items-center gap-2 rounded border px-3 py-2" title={tooltip}>
      <span style={{ width: 5, height: 5, borderRadius: 9999, backgroundColor: dotColor }} />
      <span className="font-mono text-[10px]">cluster: {label}</span>
    </div>
  );
}
