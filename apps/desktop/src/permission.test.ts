import { describe, it, expect } from "vitest";
import { decidePermission } from "./permission";

const OWN_ORIGIN = "http://127.0.0.1:5173";

function req(overrides: Partial<Parameters<typeof decidePermission>[0]> = {}) {
  return decidePermission({
    permission: "clipboard-sanitized-write",
    requestingUrl: `${OWN_ORIGIN}/`,
    ownOriginPrefix: OWN_ORIGIN,
    ...overrides,
  });
}

describe("decidePermission", () => {
  it.each([
    { permission: "clipboard-sanitized-write", requestingUrl: `${OWN_ORIGIN}/chat`, expected: true },
    { permission: "clipboard-sanitized-write", requestingUrl: `${OWN_ORIGIN}/`, expected: true },
    { permission: "clipboard-sanitized-write", requestingUrl: "https://evil.example.com/", expected: false },
    { permission: "clipboard-sanitized-write", requestingUrl: "http://127.0.0.1:51730/", expected: false },
    { permission: "clipboard-sanitized-write", requestingUrl: undefined, expected: false },
    { permission: "clipboard-read", requestingUrl: `${OWN_ORIGIN}/`, expected: false },
  ])("$permission from $requestingUrl is $expected", ({ permission, requestingUrl, expected }) => {
    expect(req({ permission, requestingUrl })).toBe(expected);
  });

  it("denies every other permission, microphone included", () => {
    for (const permission of ["media", "camera", "geolocation", "notifications", "display-capture"]) {
      expect(req({ permission })).toBe(false);
    }
  });
});
