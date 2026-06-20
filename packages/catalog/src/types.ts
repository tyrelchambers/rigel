// Catalog schema types — port of Sources/Rigel/Catalog/{CatalogApp,InstallArtifacts}.swift.
// These mirror the catalog.json shape (54 apps) loaded identically by the Swift
// and web apps. Keep the field names EXACT — they are part of the shared contract
// (docs/parity/contracts.md §3).

/**
 * Coarse buckets used by the catalog's category pill bar. The raw values are
 * what land in the bundled JSON. Mirrors Swift `AppCategory`.
 */
export type AppCategory =
  | "database"
  | "observability"
  | "productivity"
  | "dev-tools"
  | "media"
  | "network"
  | "other";

/** Stable, display order for the category pill bar (matches Swift CaseIterable). */
export const APP_CATEGORIES: AppCategory[] = [
  "database",
  "observability",
  "productivity",
  "dev-tools",
  "media",
  "network",
  "other",
];

/** Human-readable label for a category. Mirrors Swift `AppCategory.displayName`. */
export function categoryDisplayName(category: AppCategory): string {
  switch (category) {
    case "database":
      return "Database";
    case "observability":
      return "Observability";
    case "productivity":
      return "Productivity";
    case "dev-tools":
      return "Dev Tools";
    case "media":
      return "Media";
    case "network":
      return "Network";
    case "other":
      return "Other";
  }
}

/**
 * Recommended baseline resources for one instance. Strings are Kubernetes
 * quantity literals so they can be substituted directly into the install
 * prompt template. Mirrors Swift `AppRequirements`.
 */
export interface AppRequirements {
  cpuRequest: string;
  cpuLimit?: string | null;
  memoryRequest: string;
  memoryLimit?: string | null;
  /** Persistent storage size in GiB. nil/absent = stateless. */
  storageGiB?: number | null;
}

/** Charset a generated value is drawn from. Mirrors Swift `RandomSecret.Format`. */
export type SecretFormat = "alphanumeric" | "hex";

/**
 * One sensitive value the install needs. Declared authoritatively in the
 * catalog entry's baked `install.secrets` schema. Mirrors Swift `SecretFieldSpec`.
 */
export interface SecretFieldSpec {
  /** Secret data key; must match what the manifest/chart references. */
  key: string;
  label: string;
  description?: string | null;
  kind: "random" | "user";
  /** random only; default applied at generation time. */
  length?: number | null;
  /** random only; charset for generated values. Defaults to "alphanumeric". */
  format?: SecretFormat;
  /** user fields gate Continue; defaults to true. */
  required?: boolean;
}

export type InstallMode = "manifest" | "helm";

/**
 * How an app installs. Declared authoritatively by the catalog
 * (`CatalogApp.install`). Mirrors Swift `InstallDescriptor`.
 */
export interface InstallDescriptor {
  mode: InstallMode;
  repoName?: string | null;
  repoURL?: string | null;
  chart?: string | null;
  version?: string | null;
  releaseName?: string | null;
  /** Baked, {{var}}-templated multi-doc manifest (manifest mode). nil ⇒ not baked. */
  manifest?: string | null;
  /** Baked, {{var}}-templated Helm values (helm mode). nil ⇒ not baked. */
  values?: string | null;
  /** Authoritative secret schema for the install. nil/empty ⇒ scan the artifact. */
  secrets?: SecretFieldSpec[] | null;
}

/**
 * One entry in the bundled app catalog. Mirrors Swift `CatalogApp`.
 * The catalog ships with the app — there's no remote fetch in v1.
 */
export interface CatalogApp {
  /** Slug — also doubles as the default Helm-style instance name. */
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: AppCategory;
  /** SF Symbol name used as the card icon (mapped to a Lucide icon in web). */
  iconSystemName: string;
  docsURL: string;
  repoURL?: string | null;
  homepageURL?: string | null;
  tags: string[];
  /**
   * Distinctive container image repo path(s) that identify this app when found
   * running in the cluster. Registry host and `:tag` are optional; install
   * detection matches host- and tag-insensitively.
   */
  matchImages: string[];
  requirements: AppRequirements;
  /** True = needs a PVC; surfaces a "Storage" field in Configure. */
  persistence: boolean;
  /** True = surfaces an "Ingress hostname" field in Configure. */
  exposesIngress: boolean;
  /** Optional caveats / known gotchas surfaced in the detail sheet. */
  notes?: string | null;
  /** Prompt sent verbatim to the wizard's Claude session (not-yet-baked path). */
  installPromptTemplate: string;
  /** How this app installs. Absent ⇒ manifest mode (a curated default). */
  install?: InstallDescriptor | null;
}

/** True when the catalog ships a baked install artifact (manifest or values). */
export function isBaked(app: CatalogApp): boolean {
  return Boolean(app.install?.manifest || app.install?.values);
}

// --- Shared annotation constants -------------------------------------------
// A user can manually bind a catalog app to a running workload by annotating
// the workload. These keys are part of the shared contract
// (docs/parity/catalog-link-workload.md §2.1) — identical in the Swift app.
// Neither app may rename or re-derive them.

/** Annotation key whose value is the catalog app `id` a workload backs. */
export const CATALOG_APP_ANNOTATION = "rigel.dev/catalog-app";
/** Annotation key whose value is the container name `setImage` targets. */
export const CATALOG_CONTAINER_ANNOTATION = "rigel.dev/catalog-container";

/**
 * The catalog app id a controller is explicitly bound to, or null.
 * The ONLY reader of `CATALOG_APP_ANNOTATION` — detection/update functions call
 * this so the key string appears in exactly one place. Mirrors Swift `boundAppID`.
 */
export function boundAppID(meta?: {
  annotations?: Record<string, string>;
}): string | null {
  const v = meta?.annotations?.[CATALOG_APP_ANNOTATION];
  return v && v.length > 0 ? v : null;
}

/**
 * The bound container name, or null. The ONLY reader of
 * `CATALOG_CONTAINER_ANNOTATION`. Mirrors Swift `boundContainer`.
 */
export function boundContainer(meta?: {
  annotations?: Record<string, string>;
}): string | null {
  const v = meta?.annotations?.[CATALOG_CONTAINER_ANNOTATION];
  return v && v.length > 0 ? v : null;
}

// --- Minimal cluster shapes used by installedAppIDs ------------------------
// Subset of the Deployment / StatefulSet / DaemonSet / Pod schemas — only the
// container images (and the catalog binding annotations) are needed for
// installation detection.

interface ContainerLike {
  name?: string;
  image?: string;
}
interface PodSpecTemplateLike {
  spec?: { containers?: ContainerLike[] };
}
export interface DeploymentLike {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
  spec?: { template?: PodSpecTemplateLike };
}
export interface StatefulSetLike {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
  spec?: { template?: PodSpecTemplateLike };
}
/** A DaemonSet, scanned for catalog detection (kubectl set image daemonset/… is valid). */
export interface DaemonSetLike {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
  spec?: { template?: PodSpecTemplateLike };
}
/** A single entry in pod `status.containerStatuses` (subset). */
interface ContainerStatusLike {
  name?: string;
  image?: string;
  /** e.g. "ghcr.io/x/y@sha256:…" — carries the digest the node actually pulled. */
  imageID?: string;
}
export interface PodLike {
  spec?: { containers?: ContainerLike[] };
  status?: { containerStatuses?: ContainerStatusLike[] };
}
