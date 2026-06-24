/// <reference path="../.astro/types.d.ts" />

// @fontsource packages ship CSS without type declarations; allow side-effect imports.
declare module "@fontsource-variable/*";

// Optional GitHub token used at build time to authenticate the releases API
// call (dodges the 60/hr unauthenticated rate limit in CI). See releases.ts.
interface ImportMetaEnv {
  readonly GITHUB_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
