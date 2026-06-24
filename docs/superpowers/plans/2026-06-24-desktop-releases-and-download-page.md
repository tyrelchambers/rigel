# Desktop releases + download page — implementation plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Two independent workstreams (disjoint files) — runnable in parallel. Spec: `docs/superpowers/specs/2026-06-24-desktop-releases-and-download-page-design.md`.

**Decisions:** unsigned; Win NSIS x64; Linux AppImage + .deb x64; mac dmg arm64+x64; build-time static links; published release triggers marketing rebuild; tag→draft→publish flow kept.

---

## Workstream A — Multi-platform build pipeline (`apps/desktop` + `desktop-release.yml`)

### A1. electron-builder targets + stable artifact names
- Add `win` (nsis, x64) and `linux` (AppImage + deb, x64) blocks to `apps/desktop/electron-builder.yml`; keep `identity: null`, `publish.releaseType: draft`, `npmRebuild: false`.
- Set explicit `artifactName` on mac/win/linux (see spec A1) so the marketing resolver matches by a known pattern.
- Verify: `cd apps/desktop && npx electron-builder --help` is not needed; instead `pnpm --filter desktop build` still succeeds (platform-independent bundling). Don't attempt a win/linux build on this macOS machine.

### A2. package.json scripts
- Add `release:mac` / `release:win` / `release:linux` (see spec A2). Keep existing `dist`/`dist:all`/`release` or repoint `release` → `release:mac`.

### A3. desktop-release.yml matrix
- Convert the single job to a 3-OS matrix (`macos-latest`/`windows-latest`/`ubuntu-latest`), each running its `release:*` script with `GH_TOKEN` + `CSC_IDENTITY_AUTO_DISCOVERY:"false"`, `fail-fast: false`.
- Run the tag↔version check once (guard on `matrix.os == 'macos-latest'`).
- Keep `permissions: contents: write`.

### A4. Verify (A)
- `pnpm --filter desktop typecheck` + `pnpm --filter desktop test` green (config-only changes shouldn't break these).
- YAML lints (valid workflow). No local cross-build.

---

## Workstream B — Download page + resolver + rebuild automation (`apps/marketing` + `marketing-build.yml`)

### B1. `apps/marketing/src/lib/releases.ts` (pure resolver + fetch) + test
- Export `mapAssets(release)` (pure): given a GitHub release JSON `{ tag_name, assets: [{name, browser_download_url}] }`, return `{ version, assets: { macArm, macIntel, win, linuxAppImage, linuxDeb } }`, matching by extension + arch token (`.dmg`+arm64/x64; `.exe`; `.AppImage`; `.deb`). Missing → `undefined`.
- Export `async getLatestRelease()` that fetches `https://api.github.com/repos/tyrelchambers/rigel/releases/latest` (Authorization from `import.meta.env.GITHUB_TOKEN` when set), runs `mapAssets`, and on ANY failure / 404 returns a fallback `{ version: null, assets: {} }`.
- **Test** `mapAssets` against a captured fixture JSON (assets → 5 slots; partial → fallbacks). No live fetch in tests.

### B2. `apps/marketing/src/pages/download.astro` (Pencil `V0Nuz`)
- In frontmatter `await getLatestRelease()`. Render hero + primary button + platform cards (each variant `<a download href={asset ?? RELEASES_URL}>`), version + "What's new" (release URL), unsigned note, "All releases" → `https://github.com/tyrelchambers/rigel/releases`.
- `RELEASES_URL` fallback so every link works with zero releases; version line hides/"Coming soon" when `version == null`.
- Use `Base.astro` + site tokens; match the Pencil frame. Add a nav "Download" link if the site header is shared (check the header component).

### B3. OS auto-detect (`is:inline`)
- Small script: detect OS from `navigator`, set the primary button's text + href to that platform's primary asset. Progressive enhancement only.

### B4. Release → rebuild automation
- Add `on: release: { types: [released] }` to `marketing-build.yml` (keep the existing push trigger). Ensure the build step has `GITHUB_TOKEN` (already available to Actions) exported as `GITHUB_TOKEN` so `getLatestRelease()` is authenticated in CI.

### B5. Verify (B)
- `pnpm --filter marketing build` green **with zero releases** (fallback) — the page renders.
- `pnpm --filter marketing test` (or vitest) green for `mapAssets`.
- If marketing has typecheck/astro check, run it.

---

## Task C — Joint verification
- Both workstreams' suites green; `pnpm --filter marketing build` green.
- Re-read: spec asset-name patterns (A1) match the resolver patterns (B1) — same extensions/arch tokens. This is the one cross-workstream contract; keep them aligned.
- First real `git tag vX.Y.Z` push is the live end-to-end check (build all 3 OSes, publish, confirm the page resolves) — out of local scope.
