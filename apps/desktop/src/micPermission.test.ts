import { describe, it, expect } from "vitest";
import { decideMicPermission } from "./micPermission";

const OWN_ORIGIN = "http://127.0.0.1:5173";

function req(overrides: Partial<Parameters<typeof decideMicPermission>[0]> = {}) {
  return decideMicPermission({
    permission: "media",
    requestingUrl: `${OWN_ORIGIN}/`,
    mediaTypes: ["audio"],
    voiceEnabled: true,
    ownOriginPrefix: OWN_ORIGIN,
    ...overrides,
  });
}

describe("decideMicPermission", () => {
  it("grants an audio-only request from the app's own origin with voice enabled", () => {
    expect(req()).toBe(true);
  });

  it("denies when the voice flag is off", () => {
    expect(req({ voiceEnabled: false })).toBe(false);
  });

  it("denies a non-media permission (camera, geolocation, notifications, display capture)", () => {
    expect(req({ permission: "camera" })).toBe(false);
    expect(req({ permission: "geolocation" })).toBe(false);
    expect(req({ permission: "notifications" })).toBe(false);
    expect(req({ permission: "display-capture" })).toBe(false);
  });

  it("denies a request that also wants video, not just downgrades it", () => {
    expect(req({ mediaTypes: ["audio", "video"] })).toBe(false);
    expect(req({ mediaTypes: ["video"] })).toBe(false);
  });

  it("denies a request with no media types", () => {
    expect(req({ mediaTypes: [] })).toBe(false);
    expect(req({ mediaTypes: undefined })).toBe(false);
  });

  it("denies a request from a third-party origin", () => {
    expect(req({ requestingUrl: "https://evil.example.com/" })).toBe(false);
    expect(req({ requestingUrl: undefined })).toBe(false);
  });

  it("denies when the origin merely contains the prefix as a substring, not a real prefix match on a different port", () => {
    expect(req({ requestingUrl: "http://127.0.0.1:51730/" })).toBe(false);
  });
});
