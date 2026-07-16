import { classifyProvider, isCloudProvider } from "@rigel/k8s/src/provider";
import { listContexts, type ClusterContext } from "./contexts";
import { cloudEnabled } from "./entitlements";

type Loader = () => Promise<ClusterContext[]>;

const CACHE_TTL_MS = 30_000;
let cache: { at: number; contexts: ClusterContext[] } | null = null;

export function resetCloudContextCache(): void {
  cache = null;
}

async function loadCached(load: Loader): Promise<ClusterContext[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.contexts;
  const contexts = await load();
  cache = { at: Date.now(), contexts };
  return contexts;
}

export async function isCloudContext(name: string, load: Loader = listContexts): Promise<boolean> {
  let ctx = (await loadCached(load)).find((c) => c.name === name);
  if (!ctx) {
    cache = null;
    ctx = (await loadCached(load)).find((c) => c.name === name);
  }
  if (!ctx) return false;
  return isCloudProvider(classifyProvider(ctx));
}

const EXEMPT_PATHS = new Set([
  "/api/health",
  "/api/contexts",
  "/api/cluster/delete",
  "/api/cluster/disconnect",
]);

export function isCloudExempt(pathname: string): boolean {
  return EXEMPT_PATHS.has(pathname) || pathname.startsWith("/api/cloud/");
}

export function gated402(): Response {
  return Response.json({ error: "Cloud clusters are a Pro feature", gated: true }, { status: 402 });
}

export async function cloudGateResponse(
  pathname: string,
  context: string | null,
  load: Loader = listContexts,
): Promise<Response | null> {
  if (!pathname.startsWith("/api/")) return null;
  if (isCloudExempt(pathname)) return null;
  if (!context || cloudEnabled()) return null;
  return (await isCloudContext(context, load)) ? gated402() : null;
}
