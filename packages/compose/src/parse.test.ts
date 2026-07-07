import { describe, it, expect } from "vitest";
import { parseCompose } from "./parse";

const SAMPLE = `
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    environment:
      LOG_LEVEL: info
      API_TOKEN: abc
  db:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=secret
    volumes:
      - dbdata:/var/lib/postgresql/data
      - ./local:/host
    deploy:
      replicas: 2
    privileged: true
networks:
  default: {}
`;

describe("parseCompose", () => {
  it("parses services, ports, env (map and array), volumes, replicas", () => {
    const m = parseCompose(SAMPLE);
    const web = m.services.find((s) => s.name === "web")!;
    expect(web.image).toBe("nginx:1.27");
    expect(web.ports).toEqual([{ containerPort: 80, publishedPort: 8080 }]);
    expect(web.environment).toEqual({ LOG_LEVEL: "info", API_TOKEN: "abc" });

    const db = m.services.find((s) => s.name === "db")!;
    expect(db.environment).toEqual({ POSTGRES_PASSWORD: "secret" });
    expect(db.replicas).toBe(2);
    expect(db.volumes).toContainEqual({ name: "dbdata", mountPath: "/var/lib/postgresql/data", kind: "named", source: "dbdata" });
    expect(db.volumes).toContainEqual({ name: "", mountPath: "/host", kind: "bind", source: "./local" });
    expect(db.unsupported).toContain("privileged");
  });

  it("records ignored top-level keys", () => {
    expect(parseCompose(SAMPLE).ignoredTopLevel).toContain("networks");
  });

  it("throws on invalid YAML", () => {
    expect(() => parseCompose(":\n  - [unbalanced")).toThrow();
  });

  it("returns no services for empty input", () => {
    expect(parseCompose("services: {}").services).toEqual([]);
  });

  it("does not throw on a scalar service value and yields a service with no image", () => {
    const m = parseCompose("services:\n  web: nginx\n");
    const web = m.services.find((s) => s.name === "web")!;
    expect(web.image).toBeUndefined();
    expect(web.ports).toEqual([]);
    expect(web.environment).toEqual({});
    expect(web.volumes).toEqual([]);
    expect(web.dependsOn).toEqual([]);
  });

  it("returns no services when the services root is not a map", () => {
    expect(parseCompose("services: foo").services).toEqual([]);
  });

  it("normalizes depends_on as array or map to string[]", () => {
    const arr = parseCompose("services:\n  web:\n    image: nginx\n    depends_on: [db, cache]\n");
    expect(arr.services[0]!.dependsOn).toEqual(["db", "cache"]);
    const map = parseCompose("services:\n  web:\n    image: nginx\n    depends_on:\n      db:\n        condition: service_started\n");
    expect(map.services[0]!.dependsOn).toEqual(["db"]);
  });

  it("flags an unparseable port range as unsupported", () => {
    const m = parseCompose('services:\n  web:\n    image: nginx\n    ports:\n      - "3000-3005:3000-3005"\n');
    const web = m.services[0]!;
    expect(web.ports).toEqual([]);
    expect(web.unsupported).toContain("ports");
  });

  it("does not set publishedPort when the host side is missing", () => {
    const m = parseCompose('services:\n  web:\n    image: nginx\n    ports:\n      - ":80"\n');
    expect(m.services[0]!.ports).toEqual([{ containerPort: 80 }]);
  });
});
