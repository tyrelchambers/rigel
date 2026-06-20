import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentType, cacheHeaders, serveStatic } from "./staticFiles";

test("contentType maps the load-bearing SPA extensions", () => {
  expect(contentType("/assets/index-abc123.js")).toBe("text/javascript; charset=utf-8");
  expect(contentType("/assets/index-abc123.mjs")).toBe("text/javascript; charset=utf-8");
  expect(contentType("/assets/index-abc123.css")).toBe("text/css; charset=utf-8");
  expect(contentType("/index.html")).toBe("text/html; charset=utf-8");
  expect(contentType("/favicon.svg")).toBe("image/svg+xml");
  expect(contentType("/fonts/x.woff2")).toBe("font/woff2");
});

test("contentType falls back to octet-stream for unknown / extensionless paths", () => {
  expect(contentType("/weird.xyz")).toBe("application/octet-stream");
  expect(contentType("/no-extension")).toBe("application/octet-stream");
});

test("cacheHeaders: fingerprinted assets immutable, everything else no-store", () => {
  expect(cacheHeaders("/assets/index-abc.js")).toEqual({
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  expect(cacheHeaders("/index.html")).toEqual({ "Cache-Control": "no-store, must-revalidate" });
});

// Integration: serve from a temp "dist" mimicking a Vite build.
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rigel-static-"));
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><div id=root></div>");
  await writeFile(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  await writeFile(join(dir, "assets", "index-abc123.css"), ".a{}");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("REGRESSION: a JS module asset is served with a JS Content-Type (not empty)", async () => {
  // The bug: createReadStream sets no Content-Type, so the browser rejected the
  // SPA's <script type=module> ("MIME type of ''") and the app rendered blank.
  const res = await serveStatic(dir, "/assets/index-abc123.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await res.text()).toBe("console.log(1)");
});

test("serves index.html as text/html for the root path", async () => {
  const res = await serveStatic(dir, "/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-store, must-revalidate");
});

test("CSS asset gets a CSS Content-Type", async () => {
  const res = await serveStatic(dir, "/assets/index-abc123.css");
  expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
});

test("unknown SPA route falls back to index.html (so client routing works)", async () => {
  const res = await serveStatic(dir, "/pods/default");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await res.text()).toContain('id=root');
});

test("path traversal cannot escape the web dist", async () => {
  // The `..` segments are stripped, so this resolves inside dir and 404s
  // (no etc/passwd), then SPA-falls-back to index.html.
  const res = await serveStatic(dir, "/../../../../etc/passwd");
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
});

test("returns 404 when the web UI isn't built", async () => {
  const res = await serveStatic(join(dir, "does-not-exist"), "/assets/x.js");
  expect(res.status).toBe(404);
});
