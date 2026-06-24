// @ts-check
import { defineConfig, passthroughImageService } from "astro/config";
import icon from "astro-icon";

// Tailwind v4 runs via PostCSS (see postcss.config.mjs) rather than the
// @tailwindcss/vite plugin, which isn't yet compatible with Astro 6's
// Rolldown-powered Vite 8.
export default defineConfig({
  site: "https://rigel.run",
  integrations: [icon()],
  image: { service: passthroughImageService() },
  markdown: { shikiConfig: { theme: "github-dark" } },
});
