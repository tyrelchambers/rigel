import { describe, expect, it } from "vitest";
import {
  FAILOVER_PROVIDER_CHOICES,
  availableFailoverProviders,
  failoverProviderChoice,
} from "./providers";

describe("FAILOVER_PROVIDER_CHOICES", () => {
  it("offers exactly one provider that is built", () => {
    expect(availableFailoverProviders().map((c) => c.id)).toEqual(["digitalocean"]);
  });

  it("shows AWS so the chooser is a chooser, but marks it unavailable", () => {
    const aws = failoverProviderChoice("aws");
    expect(aws?.available).toBe(false);
    expect(aws?.displayName).toBe("AWS");
  });

  it("gives every choice the copy the card needs", () => {
    for (const c of FAILOVER_PROVIDER_CHOICES) {
      expect(c.displayName.length).toBeGreaterThan(0);
      expect(c.blurb.length).toBeGreaterThan(0);
    }
  });

  it("returns nothing for an id it does not know", () => {
    expect(failoverProviderChoice("linode")).toBeUndefined();
  });
});
