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
  DaemonSetLike,
  PodLike,
} from "./types";
export {
  APP_CATEGORIES,
  categoryDisplayName,
  isBaked,
  CATALOG_APP_ANNOTATION,
  CATALOG_CONTAINER_ANNOTATION,
  boundAppID,
  boundContainer,
} from "./types";

export { loadCatalog, CATALOG } from "./loader";

export { substitute } from "./substitute";

export {
  imageRepoPath,
  repoPathsMatch,
  installedAppIDs,
  installedImages,
  runningImageDigest,
} from "./detection";

export type {
  ImageReference,
  ReleaseVersion,
  UpdateStatus,
  InstalledImage,
  TagSource,
  FetchLike,
  ResolverOptions,
} from "./updates";
export {
  parseImageRef,
  parseReleaseVersion,
  versionLess,
  newestStableTag,
  pickLatestVersion,
  statusFromTags,
  schemeComparable,
  isNewerRelease,
  statusFromRelease,
  ownerRepo,
  DockerHubTagSource,
  GHCRTagSource,
  GitHubReleaseSource,
  tagSourceFor,
  registryIsKnown,
  UpdateResolver,
} from "./updates";

export type { ManifestPlaceholder } from "./placeholder";
export {
  MARKER,
  scanPlaceholders,
  substitutePlaceholders,
  hasUnfilledMarkers,
  validateManifestShape,
} from "./placeholder";

export { generateSecret } from "./randomSecret";

export type { ResourceCount, ResourceRef } from "./resourceSummary";
export { summarizeResources, listResources } from "./resourceSummary";
