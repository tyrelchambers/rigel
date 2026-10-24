/**
 * Update-check request handler for `POST /api/updates`.
 *
 * Helm-managed installs (`charts`) are checked by chart version instead: the
 * release's deployed chart (`helm status`) against the chart repo's index.
 *
 * Takes a list of full running image references and, for each, resolves an
 * update status through the deterministic resolver tiers in
 * `@rigel/catalog` (registry version tags → moving-tag digests → GitHub
 * Releases). Maps each `UpdateStatus | null` to the wire `UpdateResult` shape.
 *
 * Error handling is strictly per-image: a network failure, malformed registry
 * response, or unknown registry yields a `{ updateAvailable:false, kind:"unknown" }`
 * row with a `reason`, and NEVER fails the whole request. The resolver itself
 * already swallows per-tier exceptions (returns null); this layer adds a final
 * guard so a thrown error on one image can't take down the batch.
 *
 * Mirrors the Swift update-sweep endpoint behavior (docs/parity/updates.md).
 */

import {
  CATALOG,
  parseImageRef,
  repoURLForImage,
  statusFromTags,
  UpdateResolver,
  type InstalledImage,
  type UpdateStatus,
} from "@rigel/catalog";
import { buildHelmStatusArgs, parseChartIndexVersions, validateHelmTarget, isHttpRepoURL } from "@rigel/k8s/src/helm";
import { runProcess } from "@rigel/k8s/src/run";

/** One installed image to check. `runningDigest` is the digest the pod actually
 *  pulled (from its `imageID`); it lets the moving-tag tier detect a stale pod
 *  whose `:latest`/`:stable` tag has since advanced. A bare string is still
 *  accepted for back-compat (treated as `{ image }`, no running digest). */
export interface UpdatesImage {
  image: string;
  runningDigest?: string | null;
}

/** One Helm-managed install to check: the release backing it plus the
 *  catalog's chart coordinates. Its update is a chart version, never an image. */
export interface UpdatesChart {
  release: string;
  namespace: string;
  repoURL: string;
  chart: string;
}

/** Request body for `POST /api/updates`. */
export interface UpdatesRequest {
  images?: Array<string | UpdatesImage>;
  charts?: UpdatesChart[];
}

/** One image's update outcome on the wire. Mirrors the spec `UpdateResult`. */
export interface UpdateResult {
  /** Echoed input reference. */
  image: string;
  /** Parsed tag from the image, or null when digest-only. */
  currentTag: string | null;
  /** The version to upgrade to, or null when none / undeterminable. */
  latest: string | null;
  /** True iff a newer stable version exists. */
  updateAvailable: boolean;
  /** Which tier answered, or "unknown" when none could. */
  kind: "version" | "digest" | "none" | "unknown";
  /** For "unknown": why we couldn't decide (tooltip/debugging). */
  reason?: string;
}

/** One Helm release's update outcome on the wire. */
export interface ChartUpdateResult {
  release: string;
  namespace: string;
  chart: string;
  /** Deployed chart version, or null when the release couldn't be read. */
  currentVersion: string | null;
  /** Newer stable chart version, or null when none / undeterminable. */
  latest: string | null;
  updateAvailable: boolean;
  kind: "version" | "unknown";
  reason?: string;
}

export interface UpdatesResponse {
  results: UpdateResult[];
  /** Present only when the request carried `charts`. */
  charts?: ChartUpdateResult[];
}

/** Injectable lookups for the chart tier (real helm + HTTP by default). */
export interface ChartUpdateDeps {
  /** The deployed chart (name + version) of a release, or null if unreadable. */
  releaseChart: (release: string, namespace: string) => Promise<{ name: string; version: string } | null>;
  /** Every version of `chart` in the repo's index, or null if unreadable. */
  chartVersions: (repoURL: string, chart: string) => Promise<string[] | null>;
}

/** Real chart lookups: `helm status -o json` and the repo's `index.yaml`. */
export function defaultChartDeps(context: string | null): ChartUpdateDeps {
  return {
    async releaseChart(release, namespace) {
      const r = await runProcess("helm", buildHelmStatusArgs(release, namespace, context));
      if (r.code !== 0) return null;
      const meta = (JSON.parse(r.stdout) as { chart?: { metadata?: { name?: string; version?: string } } }).chart?.metadata;
      return meta?.name && meta.version ? { name: meta.name, version: meta.version } : null;
    },
    async chartVersions(repoURL, chart) {
      const res = await fetch(`${repoURL.replace(/\/+$/, "")}/index.yaml`);
      if (!res.ok) return null;
      return parseChartIndexVersions(await res.text(), chart);
    },
  };
}

/** Resolve one Helm release against its chart repo. Throws are the caller's to isolate. */
async function resolveChart(c: UpdatesChart, deps: ChartUpdateDeps): Promise<ChartUpdateResult> {
  const base = { release: c.release, namespace: c.namespace, chart: c.chart };
  const unknown = (currentVersion: string | null, reason: string): ChartUpdateResult => ({
    ...base, currentVersion, latest: null, updateAvailable: false, kind: "unknown", reason,
  });
  const invalid = validateHelmTarget(c.release, c.namespace) ?? (isHttpRepoURL(c.repoURL) ? null : "repo URL must be an http(s) URL");
  if (invalid) return unknown(null, invalid);

  const deployed = await deps.releaseChart(c.release, c.namespace);
  if (!deployed) return unknown(null, `could not read Helm release ${c.namespace}/${c.release}`);
  if (deployed.name !== c.chart) {
    return unknown(deployed.version, `release ${c.namespace}/${c.release} runs chart ${deployed.name}, not ${c.chart}`);
  }
  const versions = await deps.chartVersions(c.repoURL, c.chart);
  if (versions === null) return unknown(deployed.version, `could not read the chart index at ${c.repoURL}`);

  const status = statusFromTags(deployed.version, versions);
  if (status.kind === "unknown") return unknown(deployed.version, status.reason);
  if (status.kind === "updateAvailable") {
    return { ...base, currentVersion: deployed.version, latest: status.latest, updateAvailable: true, kind: "version" };
  }
  return { ...base, currentVersion: deployed.version, latest: null, updateAvailable: false, kind: "version" };
}

/**
 * Map a resolved `UpdateStatus` to the wire shape for one image.
 *
 * `digestTier` distinguishes a Tier-1.5 (moving-tag digest) answer from a
 * Tier-1/Tier-2 version answer: both surface as concrete version strings, but
 * the response `kind` records which path produced it.
 */
function toResult(
  image: string,
  currentTag: string | null,
  status: UpdateStatus | null,
  digestTier: boolean,
): UpdateResult {
  if (status === null) {
    return {
      image,
      currentTag,
      latest: null,
      updateAvailable: false,
      kind: "unknown",
      reason: "could not determine an update for this image",
    };
  }
  if (status.kind === "unknown") {
    return {
      image,
      currentTag,
      latest: null,
      updateAvailable: false,
      kind: "unknown",
      reason: status.reason,
    };
  }
  const kind: UpdateResult["kind"] = digestTier ? "digest" : "version";
  if (status.kind === "updateAvailable") {
    return {
      image,
      currentTag: status.current,
      latest: status.latest,
      updateAvailable: true,
      kind,
    };
  }
  // upToDate
  return {
    image,
    currentTag: status.current,
    latest: null,
    updateAvailable: false,
    kind,
  };
}

/**
 * Resolve update status for one image, recording which tier answered so the
 * response can label digest-tier results distinctly. Tries the registry
 * (version) tier, then the moving-tag (digest) tier, then GitHub Releases —
 * mirroring `UpdateResolver.resolveOne`, but tracking the tier.
 */
async function resolveImage(
  resolver: UpdateResolver,
  item: InstalledImage,
  currentTag: string | null,
): Promise<UpdateResult> {
  const viaRegistry = await resolver.resolveViaRegistry(item);
  if (viaRegistry) return toResult(item.image, currentTag, viaRegistry, false);

  const viaMoving = await resolver.resolveViaMovingTag(item);
  if (viaMoving) return toResult(item.image, currentTag, viaMoving, true);

  const viaReleases = await resolver.resolveViaReleases(item);
  return toResult(item.image, currentTag, viaReleases, false);
}

/**
 * Handle a `POST /api/updates` request body. Resolves every image, isolating
 * per-image failures. Accepts an optional resolver so tests can inject stubbed
 * tag sources (no network). Returns an HTTP-200-shaped payload always.
 */
export async function handleUpdates(
  body: UpdatesRequest,
  resolver: UpdateResolver = new UpdateResolver(),
  chartDeps: ChartUpdateDeps = defaultChartDeps(null),
): Promise<UpdatesResponse> {
  const entries = Array.isArray(body?.images) ? body.images : [];
  const results: UpdateResult[] = [];

  for (const entry of entries) {
    const image = typeof entry === "string" ? entry : entry?.image;
    if (typeof image !== "string" || image === "") continue;
    const runningDigest = typeof entry === "string" ? undefined : entry?.runningDigest || undefined;
    const ref = parseImageRef(image);
    const currentTag = ref?.tag ?? null;
    try {
      const repoURL = repoURLForImage(CATALOG, image) ?? undefined;
      const item: InstalledImage = { appID: image, image, runningDigest, repoURL };
      results.push(await resolveImage(resolver, item, currentTag));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({
        image,
        currentTag,
        latest: null,
        updateAvailable: false,
        kind: "unknown",
        reason,
      });
    }
  }

  if (!Array.isArray(body?.charts)) return { results };

  const charts: ChartUpdateResult[] = [];
  for (const c of body.charts) {
    try {
      charts.push(await resolveChart(c, chartDeps));
    } catch (err) {
      charts.push({
        release: c?.release, namespace: c?.namespace, chart: c?.chart,
        currentVersion: null, latest: null, updateAvailable: false, kind: "unknown",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { results, charts };
}
