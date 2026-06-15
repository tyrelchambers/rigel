// CLI: check every catalog app's pinned image(s) for a newer stable release.
//
// Reuses the in-app UpdateResolver — the SAME deterministic tiers the runtime
// update-check (`POST /api/updates`) uses: registry version tags → moving-tag
// digests → GitHub Releases. Scope is each app's PRIMARY images (those matching
// its `matchImages`), so bundled postgres/redis sidecars don't add noise.
//
//   bun run src/checkCatalogUpdates.ts              # markdown report
//   bun run src/checkCatalogUpdates.ts --json       # machine-readable
//   bun run src/checkCatalogUpdates.ts --fail-on-updates   # exit 1 if any update (CI)
//
// Network failures are per-image and never abort the run (resolver returns
// null → reported as "couldn't determine").

import { CATALOG } from "./loader";
import { UpdateResolver, parseImageRef, type UpdateStatus } from "./updates";
import { imageRepoPath, repoPathsMatch } from "./detection";
import { manifestImages } from "./manifestImages";

interface Row {
  app: string;
  image: string;
  current: string | null;
  latest: string | null;
  state: "update" | "current" | "unknown";
  reason?: string;
}

/** The pinned PRIMARY image refs for one app (manifest images matching matchImages). */
function primaryImages(app: (typeof CATALOG)[number]): string[] {
  const manifest = app.install?.manifest;
  if (typeof manifest !== "string") return [];
  const match = app.matchImages ?? [];
  const out = new Set<string>();
  for (const ref of manifestImages(manifest)) {
    const path = imageRepoPath(ref);
    if (match.some((mi) => repoPathsMatch(path, mi))) out.add(ref);
  }
  return [...out];
}

function toRow(app: string, image: string, status: UpdateStatus | null): Row {
  const current = parseImageRef(image)?.tag ?? null;
  if (status === null) {
    return { app, image, current, latest: null, state: "unknown", reason: "no resolver tier could decide" };
  }
  if (status.kind === "unknown") {
    return { app, image, current, latest: null, state: "unknown", reason: status.reason };
  }
  if (status.kind === "updateAvailable") {
    return { app, image, current: status.current, latest: status.latest, state: "update" };
  }
  return { app, image, current: status.current, latest: null, state: "current" };
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const failOnUpdates = process.argv.includes("--fail-on-updates");
  const resolver = new UpdateResolver();

  // (app, image, repoURL) work items — one per primary image, deduped by image.
  const work: { app: string; image: string; repoURL?: string }[] = [];
  const seen = new Set<string>();
  for (const app of CATALOG) {
    for (const image of primaryImages(app)) {
      if (seen.has(image)) continue;
      seen.add(image);
      work.push({ app: app.id, image, repoURL: app.repoURL ?? undefined });
    }
  }

  const rows: Row[] = await Promise.all(
    work.map(async (w) => {
      // Standard resolver path (registry → moving-tag → releases), same as the
      // runtime update badges. The registry tier rejects arch/variant/CI/build
      // tags (see pickLatestVersion), so this no longer needs a releases-first
      // workaround — and it avoids ~40 GitHub API calls per run (rate limits).
      const status = await resolver.resolveOne({ appID: w.app, image: w.image, repoURL: w.repoURL });
      return toRow(w.app, w.image, status);
    }),
  );
  rows.sort((a, b) => a.app.localeCompare(b.app));

  const updates = rows.filter((r) => r.state === "update");
  const unknown = rows.filter((r) => r.state === "unknown");

  if (json) {
    console.log(JSON.stringify({ checked: rows.length, updates, unknown, rows }, null, 2));
  } else {
    const lines: string[] = [];
    lines.push(`# Catalog image update check`);
    lines.push("");
    lines.push(`Checked **${rows.length}** primary image(s): **${updates.length}** candidate update(s), ${unknown.length} undeterminable.`);
    lines.push("");
    if (updates.length) {
      lines.push(`## ⬆️ Candidate updates`);
      lines.push("");
      lines.push(`> Verify each tag exists and is a stable release before re-pinning — rows resolved from the registry tier (no GitHub release) can pick up arch/variant/CI tags.`);
      lines.push("");
      lines.push(`| App | Image | Current | Candidate |`);
      lines.push(`| --- | --- | --- | --- |`);
      for (const r of updates) lines.push(`| ${r.app} | \`${imageRepoPath(r.image)}\` | ${r.current} | **${r.latest}** |`);
      lines.push("");
    }
    if (unknown.length) {
      lines.push(`## ❓ Couldn't determine (non-semver tag / unknown registry)`);
      lines.push("");
      for (const r of unknown) lines.push(`- ${r.app} \`${imageRepoPath(r.image)}:${r.current}\` — ${r.reason}`);
      lines.push("");
    }
    if (!updates.length) lines.push(`✅ All resolvable catalog images are up to date.`);
    console.log(lines.join("\n"));
  }

  if (failOnUpdates && updates.length > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
