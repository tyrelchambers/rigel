/**
 * Update-check request handler for `POST /api/updates`.
 *
 * Takes a list of full running image references and, for each, resolves an
 * update status through the deterministic resolver tiers in
 * `@helmsman/catalog` (registry version tags → moving-tag digests → GitHub
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
  parseImageRef,
  UpdateResolver,
  type InstalledImage,
  type UpdateStatus,
} from "@helmsman/catalog";

/** Request body for `POST /api/updates`. */
export interface UpdatesRequest {
  images: string[];
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

export interface UpdatesResponse {
  results: UpdateResult[];
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
): Promise<UpdatesResponse> {
  const images = Array.isArray(body?.images) ? body.images : [];
  const results: UpdateResult[] = [];

  for (const image of images) {
    const ref = parseImageRef(image);
    const currentTag = ref?.tag ?? null;
    try {
      const item: InstalledImage = { appID: image, image };
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

  return { results };
}
