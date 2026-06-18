import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro:schema";

// Markdown docs live under src/content/docs; each file's basename is its slug.
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum(["Get started", "Guides"]),
    order: z.number(),
    icon: z.string(),
  }),
});

export const collections = { docs };
