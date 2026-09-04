import { describe, expect, it } from "vitest";
import { suggestAddressing } from "./objectStoreAddressing";

describe("suggestAddressing", () => {
  it("suggests bucket.host for AWS and Spaces", () => {
    expect(suggestAddressing("https://s3.us-east-1.amazonaws.com")).toBe("virtualHost");
    expect(suggestAddressing("https://tor1.digitaloceanspaces.com")).toBe("virtualHost");
    expect(suggestAddressing("https://TOR1.DigitalOceanSpaces.com")).toBe("virtualHost");
  });

  it("suggests host/bucket for everything else", () => {
    expect(suggestAddressing("https://garage.default.svc.cluster.local:3900")).toBe("path");
    expect(suggestAddressing("https://s3.example.net")).toBe("path");
    expect(suggestAddressing("http://100.85.103.61:3900")).toBe("path");
  });

  it("does not match a lookalike domain", () => {
    expect(suggestAddressing("https://notamazonaws.com")).toBe("path");
    expect(suggestAddressing("https://amazonaws.com.evil.net")).toBe("path");
  });

  it("falls back to host/bucket for an endpoint it cannot parse", () => {
    expect(suggestAddressing("not a url")).toBe("path");
    expect(suggestAddressing("")).toBe("path");
  });
});
