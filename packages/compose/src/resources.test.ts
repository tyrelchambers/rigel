import { describe, it, expect } from "vitest";
import { buildDeployment, buildPvc, buildService } from "./resources";
import type { ComposeService } from "./types";

function svc(over: Partial<ComposeService>): ComposeService {
  return { name: "web", image: "nginx:1.27", ports: [], environment: {}, volumes: [], replicas: 1, unsupported: [], ...over };
}

describe("buildDeployment", () => {
  it("builds a Deployment with sanitized name, namespace, image, replicas, env", () => {
    const d = buildDeployment(svc({ name: "My_Web", environment: { LOG_LEVEL: "info" }, replicas: 3 }), "apps");
    expect(d.kind).toBe("Deployment");
    expect(d.metadata.name).toBe("my-web");
    expect(d.metadata.namespace).toBe("apps");
    expect(d.spec.replicas).toBe(3);
    const c = d.spec.template.spec.containers[0];
    expect(c.image).toBe("nginx:1.27");
    expect(c.env).toContainEqual({ name: "LOG_LEVEL", value: "info" });
  });

  it("routes secret env through secretKeyRef and mounts named volumes", () => {
    const d = buildDeployment(
      svc({ environment: { POSTGRES_PASSWORD: "x" }, volumes: [{ name: "data", mountPath: "/data", kind: "named", source: "data" }] }),
      "apps",
    );
    const c = d.spec.template.spec.containers[0];
    expect(c.env).toContainEqual({ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "web", key: "POSTGRES_PASSWORD" } } });
    expect(c.volumeMounts).toContainEqual({ name: "data", mountPath: "/data" });
    expect(d.spec.template.spec.volumes).toContainEqual({ name: "data", persistentVolumeClaim: { claimName: "web-data" } });
  });

  it("uses command as args", () => {
    const d = buildDeployment(svc({ command: ["nginx", "-g", "daemon off;"] }), "apps");
    expect(d.spec.template.spec.containers[0].args).toEqual(["nginx", "-g", "daemon off;"]);
  });
});

describe("buildPvc", () => {
  it("builds an RWO PVC named <service>-<volume>", () => {
    const p = buildPvc({ name: "data", mountPath: "/data", kind: "named", source: "data" }, svc({}), "apps");
    expect(p.kind).toBe("PersistentVolumeClaim");
    expect(p.metadata.name).toBe("web-data");
    expect(p.metadata.namespace).toBe("apps");
    expect(p.spec.accessModes).toEqual(["ReadWriteOnce"]);
  });
});

describe("buildService", () => {
  it("builds a ClusterIP Service for exposed ports", () => {
    const s = buildService(svc({ ports: [{ containerPort: 80, publishedPort: 8080 }] }), "apps");
    expect(s!.kind).toBe("Service");
    expect(s!.spec.type).toBe("ClusterIP");
    expect(s!.spec.ports).toContainEqual({ name: "p80", port: 80, targetPort: 80 });
  });
  it("returns null when the service has no ports", () => {
    expect(buildService(svc({ ports: [] }), "apps")).toBeNull();
  });
});
