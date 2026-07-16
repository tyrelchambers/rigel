---
name: cut-release
description: Use when publishing a Rigel release from the CLI (cutting a new version, tagging vX.Y.Z, publishing the GitHub Release + versioned images). Drives the RELEASING.md flow end to end with a confirmation gate before anything goes public.
---

# Cut a Rigel release

Drives the full release: bump versions in lockstep → tag → push → watch the 3-OS build (macOS + Windows + Linux) → **confirm** → publish the draft (which builds the versioned `:X.Y.Z` / `:X.Y` / `:stable` images). Background in `RELEASING.md`.

Repo is `tyrelchambers/rigel`. Releases cut from `master`. `gh` is authed.

## Preconditions

- On `master`, working tree clean (`git status`).
- `gh auth status` succeeds.

## Steps

1. **Version.** If the user gave `X.Y.Z`, use it. Otherwise show the last tag (`git tag --list 'v*' --sort=-v:refname | head -1`) and current `apps/desktop/package.json` version, and ask which bump (major/minor/patch). No leading `v`.

2. **Bump in lockstep.** `node .claude/skills/cut-release/set-versions.mjs X.Y.Z` — sets `version` in desktop, agent, marketing, and web `package.json`. (`api` has no version field.) Keeping `agent` in step matters: HELM-56's update watcher derives the agent's continuous tag minor from `agent/package.json`.

3. **Commit + tag + push.**
   ```sh
   git commit -am "release vX.Y.Z"
   git tag vX.Y.Z
   git push origin master --tags
   ```
   The push kicks off **Release Rigel desktop** (`desktop-release.yml`), which fails fast if the tag != desktop version.

4. **Watch the build.** `gh run watch $(gh run list -w "Release Rigel desktop" -L1 --json databaseId --jq '.[0].databaseId')`. A 3-OS matrix builds the macOS DMGs (arm64 + x64), the Windows `.exe`, and the Linux `.AppImage` + `.deb`, all uploaded to one **draft** Release named `vX.Y.Z` (plus the `latest-*.yml` + `.blockmap` files the in-app updater reads). Report the artifacts (`gh release view vX.Y.Z`).

5. **CONFIRM before publishing.** Publishing makes downloads public and triggers the image build. Show the draft URL and ask the user to confirm. Do not publish without an explicit yes.

6. **Generate notes + publish.**
   ```sh
   PREV=$(git tag --list 'v*' --sort=-v:refname | sed -n 2p)
   NOTES=$(gh api repos/tyrelchambers/rigel/releases/generate-notes \
     -f tag_name=vX.Y.Z -f previous_tag_name="$PREV" --jq .body)
   gh release edit vX.Y.Z --notes "$NOTES" --draft=false --latest
   ```

7. **Watch the images.** Publishing triggers **Release versioned images** (`release-images.yml`). Watch it (`gh run watch …` as in step 4 with `-w "Release versioned images"`) and report the pushed tags (`:X.Y.Z`, `:X.Y`, `:stable`) for `rigel-assistant`, `rigel-marketing`, `rigel-api`.

## Notes

- Publishing does **not** deploy to any cluster; the live cluster continuously deploys from `master` (`*-build.yml`, per-commit `:<sha>`). The versioned images are pin targets.
- Re-push a version without a new release: **Actions → Release versioned images → Run workflow** (or `gh workflow run "Release versioned images" -f version=X.Y.Z`).
- Testing the build without publishing: `gh workflow run "Release Rigel desktop"` builds a draft; delete it after.

## Common mistakes

- Tag != desktop version → step 3 workflow fails fast. Fix the version or tag and re-push.
- Publishing before the draft build finishes → the Release doesn't exist yet; wait for step 4.
- Forgetting `agent/package.json` (why step 2 bumps it) → the update watcher can misfire, showing an older manual release as "newer" than a later continuous build.
