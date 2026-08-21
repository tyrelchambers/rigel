import { describe, expect, test } from "vitest";
import { matchesTarget, missingBindings, targetsFor } from "./flattenVoiceDeps.mjs";

const MAC_ARM = { dir: "mac-arm64", os: "darwin", cpu: "arm64" };
const MAC_X64 = { dir: "mac-x64", os: "darwin", cpu: "x64" };
const LINUX = { dir: "linux-x64", os: "linux", cpu: "x64" };

describe("targetsFor", () => {
  test("macOS packages both arches, because release:mac builds both on one runner", () => {
    expect(targetsFor("darwin").map((t) => t.dir)).toEqual(["mac-arm64", "mac-x64"]);
  });

  test("the other two package themselves only", () => {
    expect(targetsFor("win32").map((t) => t.dir)).toEqual(["win-x64"]);
    expect(targetsFor("linux").map((t) => t.dir)).toEqual(["linux-x64"]);
  });
});

describe("matchesTarget", () => {
  test("a package with no constraints is portable and always included", () => {
    expect(matchesTarget({ name: "pino" }, MAC_ARM)).toBe(true);
    expect(matchesTarget({ name: "pino" }, LINUX)).toBe(true);
  });

  test("a platform package goes only to the target it was built for", () => {
    const darwinArm = { os: ["darwin"], cpu: ["arm64"] };
    expect(matchesTarget(darwinArm, MAC_ARM)).toBe(true);
    expect(matchesTarget(darwinArm, MAC_X64)).toBe(false);
    expect(matchesTarget(darwinArm, LINUX)).toBe(false);
  });

  test("os and cpu are checked independently, so a same-os wrong-arch package is rejected", () => {
    expect(matchesTarget({ os: ["darwin"] }, MAC_X64)).toBe(true);
    expect(matchesTarget({ cpu: ["arm64"] }, MAC_X64)).toBe(false);
  });

  test("musl builds are excluded from the glibc targets we ship", () => {
    expect(matchesTarget({ os: ["linux"], cpu: ["x64"], libc: ["musl"] }, LINUX)).toBe(false);
    expect(matchesTarget({ os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, LINUX)).toBe(true);
  });

  test("libc is ignored off Linux, where the field is meaningless", () => {
    expect(matchesTarget({ os: ["darwin"], cpu: ["arm64"], libc: ["glibc"] }, MAC_ARM)).toBe(true);
  });
});

describe("missingBindings", () => {
  test("a tree with both native packages is complete", () => {
    expect(
      missingBindings(["@livekit/rtc-node", "@livekit/rtc-ffi-bindings-darwin-arm64", "@livekit/local-inference-darwin-arm64"]),
    ).toEqual([]);
  });

  test("each absent binding is reported with what it costs, since neither throws at runtime", () => {
    const missing = missingBindings(["@livekit/rtc-node"]);
    expect(missing).toHaveLength(2);
    expect(missing.map(([prefix]) => prefix)).toEqual([
      "@livekit/rtc-ffi-bindings-",
      "@livekit/local-inference-",
    ]);
    expect(missing[1]![1]).toMatch(/no-op/);
  });

  test("a binding for the wrong platform does not count as present", () => {
    expect(missingBindings(["@livekit/rtc-ffi-bindings"]).map(([p]) => p)).toContain(
      "@livekit/rtc-ffi-bindings-",
    );
  });
});
