import { useQuery } from "@tanstack/react-query";

/** Live cluster JSON Schema for YAML editing, or null when unavailable
 *  (editors then run lint-only). Fetched once and cached for the session. */
async function fetchClusterYamlSchema(): Promise<Record<string, unknown> | null> {
  const res = await fetch("/api/openapi-schema");
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { schema?: Record<string, unknown> | null };
  return data.schema ?? null;
}

export function useClusterYamlSchema() {
  return useQuery({
    queryKey: ["openapi-schema"] as const,
    queryFn: fetchClusterYamlSchema,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
