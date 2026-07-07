import { describe, it, expect } from "vitest";
import { convert, combineManifests } from "./index";

const STACK = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    environment:
      APP_SECRET_KEY: change-me
  db:
    image: nextcloud:29
    environment:
      - DB_PASSWORD=secret
    volumes:
      - dbdata:/var/lib/postgresql/data
  cache:
    image: registry:2
`;

describe("golden: web + nextcloud + registry", () => {
  const r = convert(STACK, { namespace: "default" });

  it("emits 3 Deployments, 1 Service, 1 PVC", () => {
    const counts = r.manifests.reduce<Record<string, number>>((a, m) => ((a[m.kind] = (a[m.kind] ?? 0) + 1), a), {});
    expect(counts).toEqual({ Deployment: 3, Service: 1, PersistentVolumeClaim: 1 });
  });

  it("routes both secret-looking env values through secretKeyRef", () => {
    const combined = combineManifests(r.manifests);
    expect(combined).toContain("secretKeyRef");
    expect(r.warnings.filter((w) => w.directive === "APP_SECRET_KEY" || w.directive === "DB_PASSWORD").length).toBe(2);
  });

  it("hints nextcloud and the docker registry from the catalog", () => {
    const services = r.catalogHints.map((h) => h.service).sort();
    expect(services).toContain("db");
    expect(services).toContain("cache");
  });
});
