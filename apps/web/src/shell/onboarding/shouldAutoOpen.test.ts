import { describe, it, expect } from "vitest";
import { shouldAutoOpenOnboarding } from "./shouldAutoOpen";

const KIND = { name: "kind-dev", cluster: "kind-dev", server: "https://127.0.0.1:6443", active: true };

describe("shouldAutoOpenOnboarding", () => {
  it("waits until contexts have loaded", () => {
    expect(shouldAutoOpenOnboarding({ contexts: undefined, onboarded: false })).toBe(false);
  });

  it("opens for a fresh install", () => {
    expect(shouldAutoOpenOnboarding({ contexts: [], onboarded: false })).toBe(true);
  });

  it("opens for a fresh install that somehow already has a cluster", () => {
    expect(shouldAutoOpenOnboarding({ contexts: [KIND], onboarded: false })).toBe(true);
  });

  it("keeps returning while there is no cluster, even once onboarded", () => {
    expect(shouldAutoOpenOnboarding({ contexts: [], onboarded: true })).toBe(true);
  });

  it("stays shut once onboarded with a cluster attached", () => {
    expect(shouldAutoOpenOnboarding({ contexts: [KIND], onboarded: true })).toBe(false);
  });
});
