import { test, expect } from "vitest";
import { compareVersions, isNewer, checkForUpdate, releaseUrlFor, DOWNLOAD_URL } from "./appUpdate";

test("releaseUrlFor builds the GitHub tag page, normalizing a leading v", () => {
  expect(releaseUrlFor("0.4.0")).toBe("https://github.com/tyrelchambers/rigel/releases/tag/v0.4.0");
  expect(releaseUrlFor("v0.4.0")).toBe("https://github.com/tyrelchambers/rigel/releases/tag/v0.4.0");
});

test("compareVersions orders dotted numeric versions", () => {
  expect(compareVersions("0.2.1", "0.2.0")).toBe(1);
  expect(compareVersions("0.2.0", "0.2.1")).toBe(-1);
  expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  // numeric, not lexical
  expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
  // leading v tolerated, prerelease suffix ignored
  expect(compareVersions("v1.0.0", "0.9.9")).toBe(1);
  expect(compareVersions("0.2.1-beta.1", "0.2.1")).toBe(0);
});

test("isNewer is true only when latest strictly exceeds current", () => {
  expect(isNewer("0.2.1", "0.2.0")).toBe(true);
  expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  expect(isNewer("0.2.0", "0.2.1")).toBe(false);
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

test("checkForUpdate flags an update when the latest release is newer", async () => {
  const fetchFn = async () =>
    jsonResponse({ tag_name: "v0.2.1", html_url: "https://example/releases/v0.2.1" });
  const info = await checkForUpdate("0.2.0", fetchFn as typeof fetch);
  expect(info.updateAvailable).toBe(true);
  expect(info.latestVersion).toBe("0.2.1");
  expect(info.currentVersion).toBe("0.2.0");
  expect(info.downloadUrl).toBe(DOWNLOAD_URL);
  expect(info.releaseUrl).toBe("https://example/releases/v0.2.1");
});

test("checkForUpdate reports no update when already on the latest", async () => {
  const fetchFn = async () => jsonResponse({ tag_name: "v0.2.0" });
  const info = await checkForUpdate("0.2.0", fetchFn as typeof fetch);
  expect(info.updateAvailable).toBe(false);
});

test("checkForUpdate fails safe on non-ok, missing tag, or network error", async () => {
  const notOk = await checkForUpdate("0.2.0", (async () => jsonResponse({}, false)) as typeof fetch);
  expect(notOk.updateAvailable).toBe(false);
  expect(notOk.latestVersion).toBe(null);

  const noTag = await checkForUpdate("0.2.0", (async () => jsonResponse({})) as typeof fetch);
  expect(noTag.updateAvailable).toBe(false);

  const threw = await checkForUpdate(
    "0.2.0",
    (async () => {
      throw new Error("offline");
    }) as typeof fetch,
  );
  expect(threw.updateAvailable).toBe(false);
  expect(threw.downloadUrl).toBe(DOWNLOAD_URL);
});
