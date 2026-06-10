// catalog.json schema + install logic — ported from Sources/Helmsman/Catalog/.
// Loaded identically by the Swift and web apps (docs/parity/contracts.md §3).

export type {
  AppCategory,
  AppRequirements,
  SecretFormat,
  SecretFieldSpec,
  InstallMode,
  InstallDescriptor,
  CatalogApp,
  DeploymentLike,
  StatefulSetLike,
  PodLike,
} from "./types";
export { APP_CATEGORIES, categoryDisplayName, isBaked } from "./types";

export { loadCatalog, CATALOG } from "./loader";

export { substitute } from "./substitute";

export { imageRepoPath, repoPathsMatch, installedAppIDs } from "./detection";

export type { ManifestPlaceholder } from "./placeholder";
export {
  MARKER,
  scanPlaceholders,
  substitutePlaceholders,
  hasUnfilledMarkers,
  validateManifestShape,
} from "./placeholder";

export { generateSecret } from "./randomSecret";

export type { ResourceCount } from "./resourceSummary";
export { summarizeResources } from "./resourceSummary";
