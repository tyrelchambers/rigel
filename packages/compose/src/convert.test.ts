import { describe, it, expect } from "vitest";
import { convert, combineManifests } from "./convert";

const COMPOSE = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    environment:
      API_TOKEN: abc
    depends_on: [db]
  db:
    image: nextcloud:29
    volumes:
      - dbdata:/var/lib/postgresql/data
      - ./backups:/backups
    network_mode: host
networks:
  default: {}
`;

describe("convert", () => {
  const r = convert(COMPOSE, { namespace: "apps" });

  it("emits Deployments, a Service, and a PVC", () => {
    const kinds = r.manifests.map((m) => m.kind).sort();
    expect(kinds).toEqual(["Deployment", "Deployment", "PersistentVolumeClaim", "Service"]);
  });

  it("stamps the target namespace into every manifest", () => {
    for (const m of r.manifests) expect(m.yaml).toContain("namespace: apps");
  });

  it("warns about host networking, host bind mount, secret env, depends_on ordering, ignored top-level", () => {
    const msgs = r.warnings.map((w) => `${w.directive ?? ""}:${w.message}`).join("\n");
    expect(msgs).toMatch(/network_mode/);
    expect(msgs).toMatch(/backups/);
    expect(msgs).toMatch(/API_TOKEN/);
    expect(msgs).toMatch(/depends_on/);
    expect(msgs).toMatch(/networks/);
  });

  it("produces a catalog hint for a known catalog image", () => {
    expect(r.catalogHints.some((h) => h.service === "db")).toBe(true);
  });

  it("combineManifests joins docs with separators", () => {
    expect(combineManifests(r.manifests)).toContain("\n---\n");
  });
});

describe("convert depends_on warning", () => {
  it("does not warn when depends_on only appears in a comment or an env value", () => {
    const compose = `
services:
  web:
    image: nginx:1.27
    # depends_on: [db]
    environment:
      NOTE: "depends_on is not set here"
`;
    const r = convert(compose, { namespace: "apps" });
    expect(r.warnings.some((w) => w.directive === "depends_on")).toBe(false);
  });

  it("warns when a service really declares depends_on", () => {
    const compose = `
services:
  web:
    image: nginx:1.27
    depends_on: [db]
  db:
    image: nginx:1.27
`;
    const r = convert(compose, { namespace: "apps" });
    const w = r.warnings.find((w) => w.directive === "depends_on");
    expect(w?.message).toMatch(/depends_on/);
  });
});
