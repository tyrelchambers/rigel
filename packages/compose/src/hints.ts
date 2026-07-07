import { CATALOG, imageRepoPath, repoPathsMatch } from "@rigel/catalog";
import type { ComposeService, CatalogHint } from "./types";

export function catalogHints(services: ComposeService[]): CatalogHint[] {
  const out: CatalogHint[] = [];
  for (const service of services) {
    if (!service.image) continue;
    const running = imageRepoPath(service.image);
    const app = CATALOG.find((a) => a.matchImages.some((raw) => repoPathsMatch(running, imageRepoPath(raw))));
    if (app) out.push({ service: service.name, appId: app.id, appName: app.name });
  }
  return out;
}
