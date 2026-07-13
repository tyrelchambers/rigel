import { describe, expect, it } from "vitest";
import {
  mapAssets,
  bodyToNotes,
  mapReleases,
  LATEST_RELEASE_URL,
  RELEASES_URL,
  type GitHubRelease,
} from "./releases";
import fixture from "./__fixtures__/release-latest.json";

describe("mapAssets", () => {
  it("maps a full release to all five platform slots + version", () => {
    const result = mapAssets(fixture as GitHubRelease);

    expect(result.version).toBe("0.2.0");
    expect(result.url).toBe(
      "https://github.com/tyrelchambers/rigel/releases/tag/v0.2.0",
    );
    expect(result.assets.macArm).toContain("Rigel-0.2.0-arm64.dmg");
    expect(result.assets.macIntel).toContain("Rigel-0.2.0-x64.dmg");
    expect(result.assets.win).toContain("Rigel-Setup-0.2.0.exe");
    expect(result.assets.linuxAppImage).toContain("Rigel-0.2.0-x86_64.AppImage");
    expect(result.assets.linuxDeb).toContain("Rigel-0.2.0-amd64.deb");
  });

  it("strips a leading v from the tag for the version", () => {
    expect(mapAssets({ tag_name: "v1.4.2", assets: [] }).version).toBe("1.4.2");
    expect(mapAssets({ tag_name: "1.4.2", assets: [] }).version).toBe("1.4.2");
  });

  it("leaves missing platforms undefined (partial release)", () => {
    const result = mapAssets({
      tag_name: "v0.3.0",
      assets: [
        {
          name: "Rigel-0.3.0-arm64.dmg",
          browser_download_url: "https://example.com/Rigel-0.3.0-arm64.dmg",
        },
      ],
    });

    expect(result.assets.macArm).toBe("https://example.com/Rigel-0.3.0-arm64.dmg");
    expect(result.assets.macIntel).toBeUndefined();
    expect(result.assets.win).toBeUndefined();
    expect(result.assets.linuxAppImage).toBeUndefined();
    expect(result.assets.linuxDeb).toBeUndefined();
  });

  it("treats a single untagged .dmg as Apple Silicon", () => {
    const result = mapAssets({
      tag_name: "v0.4.0",
      assets: [
        {
          name: "Rigel-0.4.0.dmg",
          browser_download_url: "https://example.com/Rigel-0.4.0.dmg",
        },
      ],
    });
    expect(result.assets.macArm).toBe("https://example.com/Rigel-0.4.0.dmg");
    expect(result.assets.macIntel).toBeUndefined();
  });

  it("matches linux assets by extension regardless of arch token", () => {
    const result = mapAssets({
      tag_name: "v0.5.0",
      assets: [
        {
          name: "Rigel-0.5.0-amd64.AppImage",
          browser_download_url: "https://example.com/a.AppImage",
        },
        {
          name: "Rigel-0.5.0-x86_64.deb",
          browser_download_url: "https://example.com/b.deb",
        },
      ],
    });
    expect(result.assets.linuxAppImage).toBe("https://example.com/a.AppImage");
    expect(result.assets.linuxDeb).toBe("https://example.com/b.deb");
  });

  it("falls back to the releases page url when no html_url and yields no version when no tag", () => {
    const result = mapAssets({ assets: [] });
    expect(result.version).toBeNull();
    expect(result.url).toBe(LATEST_RELEASE_URL);
    expect(result.assets).toEqual({});
  });
});

describe("bodyToNotes", () => {
  it("strips list/heading markers and drops blank lines", () => {
    const body = "## What's new\n\n- Fixed a crash\n* Faster logs\n1. Third thing\n\nplain line";
    expect(bodyToNotes(body)).toEqual([
      "What's new",
      "Fixed a crash",
      "Faster logs",
      "Third thing",
      "plain line",
    ]);
  });

  it("returns an empty array for an empty or missing body", () => {
    expect(bodyToNotes(undefined)).toEqual([]);
    expect(bodyToNotes("")).toEqual([]);
    expect(bodyToNotes("\n\n  \n")).toEqual([]);
  });
});

describe("mapReleases", () => {
  it("maps releases newest-first with version, date, url and notes", () => {
    const out = mapReleases([
      {
        name: "v0.2.0",
        tag_name: "v0.2.0",
        html_url: "https://example.com/0.2.0",
        published_at: "2026-07-10T12:00:00Z",
        body: "- Added digests\n- Fixed alerts",
      },
    ]);
    expect(out).toEqual([
      {
        version: "0.2.0",
        date: "2026-07-10",
        url: "https://example.com/0.2.0",
        notes: ["Added digests", "Fixed alerts"],
      },
    ]);
  });

  it("skips drafts and falls back for missing fields", () => {
    const out = mapReleases([
      { tag_name: "v0.3.0", draft: true, body: "hidden" },
      { tag_name: "0.1.0" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.version).toBe("0.1.0");
    expect(out[0]!.date).toBe("");
    expect(out[0]!.url).toBe(RELEASES_URL);
    expect(out[0]!.notes).toEqual([]);
  });
});
