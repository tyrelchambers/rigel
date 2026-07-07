import { describe, it, expect } from "vitest";
import { catalogHints } from "./hints";
import type { ComposeService } from "./types";

function svc(name: string, image: string): ComposeService {
  return { name, image, ports: [], environment: {}, volumes: [], replicas: 1, dependsOn: [], unsupported: [] };
}

describe("catalogHints", () => {
  it("matches a known image to a catalog app (host/tag-insensitive)", () => {
    const hints = catalogHints([svc("files", "nextcloud:29-apache")]);
    expect(hints.some((h) => h.service === "files")).toBe(true);
  });
  it("produces no hint for an unknown image", () => {
    expect(catalogHints([svc("web", "example.com/nobody/unknown-thing:1")])).toEqual([]);
  });
  it("ignores services without an image", () => {
    expect(catalogHints([{ ...svc("x", ""), image: undefined }])).toEqual([]);
  });
});
