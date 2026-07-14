# Releasing the Rigel desktop app

This is how a new downloadable build of the desktop app gets made. The short
version: you bump the version and push a tag; GitHub Actions builds the installers
for **macOS, Windows, and Linux** and puts them on a single draft Release; you
look it over and click Publish.

The builds are **unsigned** for now (more on that below). Code signing and
notarization are planned later phases.

## The moving parts

Three files make this work:

- **`.github/workflows/desktop-release.yml`** — the GitHub Actions workflow. It
  runs a **3-OS matrix** (macOS, Windows, Linux — each on its own native runner)
  whenever you push a tag like `v0.2.0`. Each runner builds only its own platform
  (node-pty's native addon is packed from that runner's prebuild, no
  cross-compile) and uploads to the same draft Release.
- **`apps/desktop/electron-builder.yml`** — how the app is packaged. The
  `publish:` block points at this GitHub repo, so electron-builder knows where to
  upload. The `mac`/`win`/`linux` blocks define the per-platform targets, and
  `identity: null` (plus no Win/Linux signing) means the build is unsigned for now.
- **`apps/desktop/package.json`** — the per-platform `release:mac` / `release:win`
  / `release:linux` scripts the matrix runs, e.g.
  `pnpm build && electron-builder --mac --arm64 --x64 --publish always`.

## Cutting a release

1. **Bump the version.** Edit `version` in `apps/desktop/package.json`
   (for example `0.1.0` → `0.2.0`). Use [semver](https://semver.org/).

2. **Commit it.**

   ```sh
   git commit -am "release v0.2.0"
   ```

3. **Tag and push.** The tag must be `v` + the version you just set.

   ```sh
   git tag v0.2.0
   git push origin master --tags
   ```

That's it. Pushing the tag kicks off the workflow.

> The workflow checks that the tag matches the version in
> `apps/desktop/package.json` and fails fast if they don't, so the two can't
> drift. If it fails on this, fix the version or the tag and re-push.

## What happens next

The workflow (watch it under the repo's **Actions** tab) runs the matrix — each
runner installs the workspace, verifies the tag matches
`apps/desktop/package.json` (once, on the macOS runner), and runs its
`release:<platform>` script. `electron-builder` packages, per platform:

- **macOS** — `Rigel-<version>-arm64.dmg` (Apple Silicon) and
  `Rigel-<version>-x64.dmg` (Intel), plus `latest-mac.yml`.
- **Windows** — `Rigel-Setup-<version>.exe` (NSIS, x64), plus `latest.yml`.
- **Linux** — `Rigel-<version>-x86_64.AppImage` and `Rigel-<version>-amd64.deb`
  (x64), plus `latest-linux.yml`.

The `latest-*.yml` manifests are what a future auto-updater will read. All of it
uploads to the same **draft** GitHub Release named for the version. A final
`strip-blockmaps` job then prunes the `.blockmap` delta-update artifacts (unused
until auto-update is wired; the `latest-*.yml` manifests are kept).

Nothing is public yet. Go to the repo's **Releases** page, find the draft, check
the files are attached and the notes read the way you want, then click
**Publish release**. The download links on the Releases page go live at that
point.

## Versioned container images

Publishing the release also versions the deployable images. The
`release-images.yml` workflow runs on **release publish** and builds three
images tagged with the release version:

- `ghcr.io/<owner>/rigel-assistant` (the in-cluster agent)
- `ghcr.io/<owner>/rigel-marketing`
- `ghcr.io/<owner>/rigel-signups`

Each gets three tags: `:X.Y.Z` (the exact version, immutable), `:X.Y` (the minor
track), and `:stable` (a moving tag that always points at the latest published
release). Self-hosters pin whichever they want.

This is independent of the cluster: publishing does **not** deploy anything. The
live cluster still continuously deploys from `master` (the `*-build.yml`
workflows pin the per-commit `:<sha>`). These release images are artifacts to
pin, not a deploy trigger.

To re-push a version without cutting a new release (say a registry hiccup), use
**Actions → Release versioned images → Run workflow** and enter the version.

## Why the builds are unsigned (and what users see)

We haven't set up code signing or notarization yet, so on first open users get a
warning:

- **macOS** can't verify the developer. The one-time workaround is: **right-click
  the app → Open**, then confirm. After that it launches normally.
- **Windows** SmartScreen shows "Windows protected your PC." The workaround is:
  **More info → Run anyway**.

Fixing this properly (so it opens with no warning) needs an Apple Developer
account + Developer ID certificate for macOS and an Authenticode certificate for
Windows. That's a planned follow-up; see below. Until then, the download page
should spell out these one-time steps so first-run isn't a dead end.

## Testing the pipeline without publishing

If you want to make sure the build works without cutting a real version, trigger
the workflow manually:

- Go to **Actions → Release Rigel desktop → Run workflow**, or run
  `gh workflow run "Release Rigel desktop"`.

It builds and creates a **draft** release (still hidden from the public). Inspect
the artifacts, then delete the draft if you were just testing.

## Building locally

You don't need CI to produce a `.dmg`. From the repo root:

```sh
pnpm --filter desktop dist       # Apple Silicon only (fast)
pnpm --filter desktop dist:all   # Apple Silicon + Intel
```

The output lands in `apps/desktop/release/`. This builds the installers but does
**not** upload anything — handy for trying a build before you tag.

## Planned follow-ups

- **Signing + notarization (Phase 2):** for macOS, join the Apple Developer
  Program, add a Developer ID certificate and notarization credentials as GitHub
  secrets, and set `identity` in `electron-builder.yml`; for Windows, add an
  Authenticode certificate. Downloads then open with no warning. This drops into
  the same workflow; the steps above don't change.
- **In-app auto-update (Phase 3):** add `electron-updater` so the app updates
  itself from the `latest-*.yml` manifests each release already publishes (and
  stop stripping the `.blockmap` files, which enable delta updates).
