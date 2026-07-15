/// <reference path="../.astro/types.d.ts" />

// @fontsource packages ship CSS without type declarations; allow side-effect imports.
declare module "@fontsource-variable/*";

// Optional GitHub token used at build time to authenticate the releases API
// call (dodges the 60/hr unauthenticated rate limit in CI). See releases.ts.
interface ImportMetaEnv {
  readonly GITHUB_TOKEN?: string;
  // On a release-triggered build, the just-published tag (e.g. "v0.2.2"); makes
  // the resolver fetch that exact release instead of the lagged /latest. See releases.ts.
  readonly RIGEL_RELEASE_TAG?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
