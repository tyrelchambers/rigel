import { describe, expect, it } from "vitest";
import { mapAssets, LATEST_RELEASE_URL, type GitHubRelease } from "./releases";
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
