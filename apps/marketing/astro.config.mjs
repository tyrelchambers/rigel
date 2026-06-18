// @ts-check
import { defineConfig, passthroughImageService } from "astro/config";
import icon from "astro-icon";

// Static marketing site for Helmsman. Zero client JS by default — the only
// motion is CSS, and the mobile nav is a native <details> disclosure.
//
// Tailwind v4 runs via PostCSS (see postcss.config.mjs) rather than the
// @tailwindcss/vite plugin, which isn't yet compatible with Astro 6's
// Rolldown-powered Vite 8.
export default defineConfig({
  site: "https://helmsman.run",
  integrations: [icon()],
  // No raster image optimization is used (SVG/CSS only), so skip the sharp
  // service entirely — keeps the build dependency-free and fast.
  image: { service: passthroughImageService() },
  // Dark Shiki theme for code blocks in the ported docs.
  markdown: { shikiConfig: { theme: "github-dark" } },
});
