import { describe, it, expect } from "vitest";
import { convert, combineManifests } from "./convert";

function kinds(r: ReturnType<typeof convert>): string[] {
  return r.manifests.map((m) => m.kind);
}

const SECRET_STACK = `
services:
  web:
    image: nginx:1.27
    environment:
      API_TOKEN: abc
      LOG_LEVEL: info
`;

describe("emitSecrets fix", () => {
  it("off: keeps the secret-env warning and attaches fix option", () => {
    const r = convert(SECRET_STACK, { namespace: "apps" });
    const w = r.warnings.find((w) => w.directive === "API_TOKEN");
    expect(w).toBeDefined();
    expect(w!.fix?.option).toBe("emitSecrets");
    expect(kinds(r)).not.toContain("Secret");
  });

  it("on: emits an Opaque Secret with stringData and drops the warning", () => {
    const r = convert(SECRET_STACK, { namespace: "apps", fixes: { emitSecrets: true } });
    const secret = r.manifests.find((m) => m.kind === "Secret");
    expect(secret).toBeDefined();
    expect(secret!.yaml).toContain("type: Opaque");
    expect(secret!.yaml).toContain("name: web");
    expect(secret!.yaml).toContain("API_TOKEN: abc");
    expect(secret!.yaml).not.toContain("LOG_LEVEL");
    expect(r.warnings.some((w) => w.directive === "API_TOKEN")).toBe(false);
  });
});

const BIND_STACK = `
services:
  db:
    image: nextcloud:29
    volumes:
      - ./backups:/backups
`;

describe("bindMountsToPvc fix", () => {
  it("off: keeps the bind-mount warning with fix option", () => {
    const r = convert(BIND_STACK, { namespace: "apps" });
    const w = r.warnings.find((w) => w.directive === "volumes");
    expect(w!.fix?.option).toBe("bindMountsToPvc");
    expect(kinds(r)).not.toContain("PersistentVolumeClaim");
  });

  it("on: emits a PVC and wires the volume + mount into the Deployment", () => {
    const r = convert(BIND_STACK, { namespace: "apps", fixes: { bindMountsToPvc: true } });
    const pvc = r.manifests.find((m) => m.kind === "PersistentVolumeClaim");
    expect(pvc!.name).toBe("db-backups");
    const dep = r.manifests.find((m) => m.kind === "Deployment")!;
    expect(dep.yaml).toContain("mountPath: /backups");
    expect(dep.yaml).toContain("claimName: db-backups");
    expect(r.warnings.some((w) => w.directive === "volumes")).toBe(false);
  });
});

const EXPOSE_STACK = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
`;

const TWO_EXPOSED = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
  api:
    image: nginx:1.27
    ports: ["9090:90"]
`;

describe("expose fix", () => {
  it("off: keeps the published-port warning with fix option and ClusterIP", () => {
    const r = convert(EXPOSE_STACK, { namespace: "apps" });
    const w = r.warnings.find((w) => w.directive === "ports");
    expect(w!.fix?.option).toBe("expose");
    const svc = r.manifests.find((m) => m.kind === "Service")!;
    expect(svc.yaml).toContain("type: ClusterIP");
  });

  it("loadbalancer: published-port Service becomes LoadBalancer and warning is gone", () => {
    const r = convert(EXPOSE_STACK, { namespace: "apps", fixes: { expose: "loadbalancer" } });
    const svc = r.manifests.find((m) => m.kind === "Service")!;
    expect(svc.yaml).toContain("type: LoadBalancer");
    expect(r.warnings.some((w) => w.directive === "ports")).toBe(false);
  });

  it("ingress with host: keeps ClusterIP and emits one Ingress with a single-service path /", () => {
    const r = convert(EXPOSE_STACK, { namespace: "apps", fixes: { expose: "ingress", ingressHost: "example.com" } });
    const svc = r.manifests.find((m) => m.kind === "Service")!;
    expect(svc.yaml).toContain("type: ClusterIP");
    const ing = r.manifests.find((m) => m.kind === "Ingress")!;
    expect(ing.yaml).toContain("host: example.com");
    expect(ing.yaml).toContain("path: /");
    expect(ing.yaml).toContain("name: web");
    expect(ing.yaml).toContain("number: 80");
    expect(r.warnings.some((w) => w.directive === "ports")).toBe(false);
  });

  it("ingress with two exposed services: one rule per service with /<service> paths", () => {
    const r = convert(TWO_EXPOSED, { namespace: "apps", fixes: { expose: "ingress", ingressHost: "example.com" } });
    const ing = r.manifests.find((m) => m.kind === "Ingress")!;
    expect(ing.yaml).toContain("path: /web");
    expect(ing.yaml).toContain("path: /api");
  });

  it("ingress with no host: no-op that keeps the warnings", () => {
    const r = convert(EXPOSE_STACK, { namespace: "apps", fixes: { expose: "ingress" } });
    expect(kinds(r)).not.toContain("Ingress");
    expect(r.warnings.some((w) => w.directive === "ports")).toBe(true);
  });
});

const DEPENDS_STACK = `
services:
  web:
    image: nginx:1.27
    depends_on: [db, log]
  db:
    image: nextcloud:29
    ports: ["5432:5432"]
  log:
    image: busybox:1.36
`;

describe("addWaitInit fix", () => {
  it("off: keeps the depends_on warning with fix option", () => {
    const r = convert(DEPENDS_STACK, { namespace: "apps" });
    const w = r.warnings.find((w) => w.directive === "depends_on");
    expect(w!.fix?.option).toBe("addWaitInit");
  });

  it("on: adds wait-for init containers using the dep port, with nslookup fallback", () => {
    const r = convert(DEPENDS_STACK, { namespace: "apps", fixes: { addWaitInit: true } });
    const web = r.manifests.find((m) => m.name === "web")!;
    expect(web.yaml).toContain("name: wait-for-db");
    expect(web.yaml).toContain("nc -z db 5432");
    expect(web.yaml).toContain("name: wait-for-log");
    expect(web.yaml).toContain("nslookup log");
    expect(web.yaml).toContain("image: busybox:1.36");
    expect(r.warnings.some((w) => w.directive === "depends_on")).toBe(false);
  });
});

describe("all fixes at once", () => {
  const STACK = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    environment:
      API_TOKEN: abc
    depends_on: [db]
    volumes:
      - ./html:/usr/share/nginx/html
  db:
    image: nextcloud:29
    ports: ["5432:5432"]
`;

  it("produces a valid multi-doc manifest with no fixable warnings remaining", () => {
    const r = convert(STACK, {
      namespace: "apps",
      fixes: { emitSecrets: true, bindMountsToPvc: true, expose: "loadbalancer", addWaitInit: true },
    });
    const combined = combineManifests(r.manifests);
    expect(combined).toContain("\n---\n");
    expect(kinds(r)).toContain("Secret");
    expect(kinds(r)).toContain("PersistentVolumeClaim");
    expect(r.warnings.some((w) => w.fix)).toBe(false);
  });

  it("is idempotent across repeated conversions", () => {
    const opts = { namespace: "apps", fixes: { emitSecrets: true, bindMountsToPvc: true, expose: "loadbalancer" as const, addWaitInit: true } };
    const a = combineManifests(convert(STACK, opts).manifests);
    const b = combineManifests(convert(STACK, opts).manifests);
    expect(a).toBe(b);
  });
});
