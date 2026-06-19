import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/**
 * Content-Type by file extension for the built web UI.
 *
 * CRITICAL: the Node port serves static files via `createReadStream`, which —
 * unlike Bun's `Bun.file()` — does NOT infer a Content-Type. Without an explicit
 * type the SPA's `<script type="module">` is served with an empty MIME and the
 * browser REJECTS it under strict module-MIME checking ("responded with a MIME
 * type of ''"), so React never mounts and the window renders blank. So we MUST
 * set Content-Type here. `.js`/`.css`/`.html` are load-bearing; the rest cover
 * Vite's asset output (fonts, images, source maps, wasm).
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

/** Map a request path / filename to a Content-Type by extension. */
export function contentType(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  const ext = dot >= 0 ? pathname.slice(dot).toLowerCase() : "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Cache policy for the SPA: Vite fingerprints assets (e.g. `/assets/index-<hash>.js`),
 * so those are safe to cache forever (a new build → a new filename). But
 * `index.html` references the current hashed bundle, so it MUST NOT be cached —
 * otherwise the browser keeps loading the previous build's JS after a redeploy
 * (the classic "I rebuilt but still see the old UI" trap). Serve fingerprinted
 * assets immutable; serve index.html (and SPA fallbacks) no-store.
 */
export function cacheHeaders(pathname: string): HeadersInit {
  if (pathname.startsWith("/assets/")) {
    return { "Cache-Control": "public, max-age=31536000, immutable" };
  }
  return { "Cache-Control": "no-store, must-revalidate" };
}

/** True when `full` exists and is a regular file. */
async function isFile(full: string): Promise<boolean> {
  return stat(full).then((s) => s.isFile()).catch(() => false);
}

/** Stream a file's bytes as a Fetch Response, with a Content-Type by extension. */
function fileResponse(full: string, headers: HeadersInit): Response {
  const body = Readable.toWeb(createReadStream(full)) as unknown as BodyInit;
  const h = new Headers(headers);
  if (!h.has("Content-Type")) h.set("Content-Type", contentType(full));
  return new Response(body, { headers: h });
}

/** Serve a file from the built web UI (`webDist`), falling back to index.html for SPA routes. */
export async function serveStatic(webDist: string, pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  // Guard against path traversal escaping webDist.
  const safe = rel.split("/").filter((s) => s !== "..").join("/");
  const direct = `${webDist}/${safe}`;
  if (await isFile(direct)) return fileResponse(direct, cacheHeaders(rel));
  // SPA fallback → index.html, which must always revalidate.
  const index = `${webDist}/index.html`;
  if (await isFile(index)) return fileResponse(index, { "Cache-Control": "no-store, must-revalidate" });
  return new Response("web UI not built (run `pnpm --filter web build`)", { status: 404 });
}
