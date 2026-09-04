import { afterEach, describe, expect, it, vi } from "vitest";
import { detectOS, pkgLabel } from "./installHelp";

afterEach(() => {
  vi.unstubAllGlobals();
});

function ua(value: string) {
  vi.stubGlobal("navigator", { userAgent: value });
}

describe("detectOS", () => {
  it("reads the platform out of the user agent", () => {
    ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(detectOS()).toBe("macos");
    ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(detectOS()).toBe("windows");
    ua("Mozilla/5.0 (X11; Linux x86_64)");
    expect(detectOS()).toBe("linux");
  });

  it("returns nothing rather than guessing", () => {
    ua("some-headless-thing/1.0");
    expect(detectOS()).toBeNull();
  });
});

describe("pkgLabel", () => {
  it("names the package manager a command belongs to", () => {
    expect(pkgLabel("brew install doctl")).toBe("Homebrew");
    expect(pkgLabel("winget install doctl")).toBe("winget");
    expect(pkgLabel("apt install doctl")).toBe("APT");
  });

  it("falls back to the command itself when it knows no better", () => {
    expect(pkgLabel("nix-env -i doctl")).toBe("nix-env");
  });
});
