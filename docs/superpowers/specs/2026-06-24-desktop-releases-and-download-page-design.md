# Cross-platform desktop releases + download page

**Status:** Design / spec (2026-06-24). Branch `feat/desktop-releases-download-page`.

**Goal:** Ship the Rigel desktop app for **macOS, Windows, and Linux** from one tag, and add a Lens-style **download page** to the marketing site (rigel.run/download) whose buttons resolve to the latest release at build time.

## Decisions (confirmed)

- **Unsigned** builds for now (matches macOS today). Win shows SmartScreen; macOS needs right-click → Open; the page says so. No new signing secrets. Signing is a later phase.
- **Linux:** AppImage + `.deb`. **Windows:** NSIS `.exe`, x64. **macOS:** `.dmg`, arm64 + x64 (unchanged).
- **Links:** resolved at **marketing build time** (static hrefs baked in), so a **published release must trigger a marketing rebuild**. OS auto-detect is a tiny client script that only highlights/relabels the primary button; the hrefs themselves are static.
- Keep the existing flow: push tag `vX.Y.Z` → builds upload to a **draft** GitHub Release → review → **Publish**. The page reads the latest **published** release.

## Part A — Multi-platform build pipeline

### A1. `apps/desktop/electron-builder.yml`
Add Windows + Linux targets and **explicit `artifactName`s** (so the marketing resolver can match assets reliably regardless of electron-builder defaults):

```yaml
win:
  target: [{ target: nsis, arch: [x64] }]
  artifactName: Rigel-Setup-${version}.exe
linux:
  category: Development
  target:
    - { target: AppImage, arch: [x64] }
    - { target: deb, arch: [x64] }
  artifactName: Rigel-${version}-${arch}.${ext}   # Rigel-0.2.0-x86_64.AppImage / Rigel-0.2.0-amd64.deb
mac:
  # unchanged; add an explicit name for matching:
  artifactName: Rigel-${version}-${arch}.dmg      # Rigel-0.2.0-arm64.dmg / Rigel-0.2.0-x64.dmg
```
Keep `identity: null` / unsigned. `publish` stays `releaseType: draft`. electron-builder also emits `latest-mac.yml` / `latest-linux.yml` / `latest.yml` (future auto-update; harmless now).

> The exact arch token electron-builder substitutes (`x64` vs `x86_64` vs `amd64`) differs per target/ext. The resolver (Part B) matches by **extension + platform**, not a hardcoded arch string, and uses `arch` from each asset where needed. Lock the names by reading the first real build's asset list and adjust the regex if needed (capture this in the plan's verification step).

### A2. `apps/desktop/package.json` scripts
Add per-platform build scripts so each CI runner builds only its platform:
```
"release:mac":   "pnpm build && electron-builder --mac --arm64 --x64 --publish always",
"release:win":   "pnpm build && electron-builder --win --x64 --publish always",
"release:linux": "pnpm build && electron-builder --linux --x64 --publish always"
```
`pnpm build` already builds the SPA + esbuild bundles; it is platform-independent. node-pty ships its per-platform prebuild from each runner (npmRebuild stays false).

### A3. `.github/workflows/desktop-release.yml` → matrix
Replace the single macos job with a matrix that publishes to the **same** draft release:
```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - { os: macos-latest,   script: release:mac }
      - { os: windows-latest, script: release:win }
      - { os: ubuntu-latest,  script: release:linux }
runs-on: ${{ matrix.os }}
```
Keep the tag↔version check (run it once, e.g. only on macos) and `CSC_IDENTITY_AUTO_DISCOVERY: "false"`, `GH_TOKEN`. Linux deb build needs no extra apt deps for AppImage/deb on ubuntu-latest (electron-builder bundles fpm); if a missing lib surfaces, add it in the plan.

**Concurrency caveat:** three jobs publishing to one draft release can race on draft creation. Mitigate by giving macOS a tiny head start is fragile; the robust option (note as a follow-up if races appear) is build-artifacts-then-one-publish-job. Start with parallel `--publish always` (electron-builder is generally idempotent finding the draft by version) and watch the first run.

## Part B — Download page (rigel.run/download)

### B1. `apps/marketing/src/pages/download.astro`
Built to Pencil frame **"Marketing — Download page"** (`V0Nuz`). Uses `Base.astro` + the site tokens (`#0c0d0f`, `surface`/`surface-elevated`, `accent #38bdf8`, `ink-gradient`, Geist). Sections:
- Hero: eyebrow "DESKTOP APP", ink-gradient h1 "Download Rigel Desktop", subtitle.
- **Primary button** (accent) for the auto-detected OS + a `version · What's new ↗` line.
- **Platform cards:** macOS (Apple Silicon `.dmg`, Intel `.dmg`), Windows (`.exe`), Linux (AppImage, `.deb`). Each variant row is an `<a download>` to the resolved asset URL.
- Note strip: unsigned caveat (macOS right-click → Open; Windows More info → Run) + "All releases ↗" (the GitHub releases page) + "System requirements".

### B2. Build-time link resolution — `apps/marketing/src/lib/releases.ts`
At build (Astro frontmatter), fetch `https://api.github.com/repos/tyrelchambers/rigel/releases/latest` (honor an optional `GITHUB_TOKEN` env to dodge the 60/hr unauth limit in CI) and map assets → `{ version, assets: { macArm, macIntel, win, linuxAppImage, linuxDeb } }` by extension + arch token. **Graceful fallback:** if the request fails or no release exists yet (true today), every link falls back to the GitHub **releases page** (`/releases/latest`) and the version line reads "Coming soon" / hides — the page must build green with zero releases.

### B3. OS auto-detect — small client script
`is:inline` script: read `navigator.userAgent`/`platform`, pick the platform, and set the primary button's label + href to that platform's primary asset (mac → Apple Silicon by default, with an "Intel?" sublink). Pure progressive enhancement; the static platform cards already cover every OS if JS is off.

## Part C — Release → marketing rebuild automation

A published release must refresh the baked links. Add to **`marketing-build.yml`** a `release: { types: [released] }` trigger (in addition to its current push-paths trigger) so publishing a desktop release rebuilds + redeploys the marketing site, re-running the Part B resolver against the new latest release. (The desktop release is a separate repo Release event; `released` fires on publish, not on the draft.) Pass `GITHUB_TOKEN` to the build step for the API call.

## Non-goals
- Code signing / notarization (later phase; needs certs).
- Auto-update (electron-updater) — the `latest-*.yml` manifests are emitted but not wired.
- Windows arm64, Linux rpm/snap (can add later; arch is data-driven in the resolver).
- Replacing the existing early-access waitlist CTA — leave it; the download page is additive.

## Testing / verification
- `pnpm --filter marketing build` is green **with zero releases** (fallback path) and renders all platform cards.
- `releases.ts` mapping is unit-tested against a captured GitHub API JSON fixture (assets → the 5 platform slots; missing assets → fallback). No live API call in tests.
- electron-builder config: assert (in the plan) the `artifactName`s resolve; first real tag build is the live verification — capture the actual asset names and reconcile the resolver regex.
- Desktop builds themselves are verified by the first matrix run (can't build win/linux locally on this macOS dev machine).
