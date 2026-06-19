# Releasing the Rigel desktop app

This is how a new downloadable build of the Mac app gets made. The short version:
you bump the version and push a tag; GitHub Actions builds the installers and
puts them on a draft Release; you look it over and click Publish.

Right now this covers **macOS only**, and the builds are **unsigned** (more on
that below). Windows/Linux and code signing are planned later phases.

## The moving parts

Three files make this work:

- **`.github/workflows/desktop-release.yml`** — the GitHub Actions workflow. It
  runs on a macOS runner whenever you push a tag like `v0.2.0`.
- **`apps/desktop/electron-builder.yml`** — how the app is packaged. The
  `publish:` block points at this GitHub repo, so electron-builder knows where to
  upload. `identity: null` means the build is unsigned for now.
- **`apps/desktop/package.json`** — the `release` script the workflow runs:
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

The workflow (watch it under the repo's **Actions** tab) does this on a
`macos-latest` runner:

1. Installs the workspace and runs the `release` script.
2. `electron-builder` packages two installers:
   - `Rigel-<version>-arm64.dmg` — Apple Silicon (M-series)
   - `Rigel-<version>-x64.dmg` — Intel
   - plus `latest-mac.yml`, the manifest a future auto-updater will read.
3. Uploads all of it to a **draft** GitHub Release named for the version.

Nothing is public yet. Go to the repo's **Releases** page, find the draft, check
the files are attached and the notes read the way you want, then click
**Publish release**. The download links on the Releases page go live at that
point.

## Why the builds are unsigned (and what users see)

We haven't set up Apple code signing or notarization yet, so when someone
downloads the `.dmg` and opens it, macOS will warn that it can't verify the
developer. The one-time workaround is: **right-click the app → Open**, then
confirm. After that it launches normally.

Fixing this properly (so it opens with no warning) needs an Apple Developer
account and signing credentials. That's a planned follow-up; see below.

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

- **Signing + notarization (Phase 2):** join the Apple Developer Program, add a
  Developer ID certificate and notarization credentials as GitHub secrets, and
  flip `identity` in `electron-builder.yml`. Downloads then open with no warning.
  This drops into the same workflow; the steps above don't change.
- **In-app auto-update (Phase 3):** add `electron-updater` so the app updates
  itself from the `latest-mac.yml` each release already publishes.
- **More platforms:** add `win` and `linux` targets to `electron-builder.yml`
  and matching runners to the workflow matrix when Windows/Linux builds are
  wanted.
