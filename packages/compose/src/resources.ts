import { sanitizeName } from "./names";
import { isSecretEnvKey } from "./env";
import type { ComposeService, ComposeVolume, ConvertFixes } from "./types";

type Obj = Record<string, any>;

function pvcName(service: ComposeService, vol: ComposeVolume): string {
  return `${sanitizeName(service.name)}-${sanitizeName(vol.name || vol.mountPath)}`;
}

function volName(vol: ComposeVolume): string {
  return vol.kind === "named" ? vol.name : sanitizeName(vol.mountPath);
}

function envEntries(service: ComposeService): Obj[] {
  const secretName = sanitizeName(service.name);
  return Object.entries(service.environment).map(([name, value]) =>
    isSecretEnvKey(name)
      ? { name, valueFrom: { secretKeyRef: { name: secretName, key: name } } }
      : { name, value },
  );
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function waitInitContainers(service: ComposeService, firstPorts: Record<string, number>): Obj[] {
  return service.dependsOn.map((dep) => {
    const d = sanitizeName(dep);
    const port = firstPorts[dep];
    const cmd =
      port != null
        ? `until nc -z ${d} ${port}; do echo waiting for ${d}; sleep 2; done`
        : `until nslookup ${d}; do sleep 2; done`;
    return { name: `wait-for-${d}`, image: "busybox:1.36", command: ["sh", "-c", cmd] };
  });
}

export function buildDeployment(
  service: ComposeService,
  namespace: string,
  fixes: ConvertFixes = {},
  firstPorts: Record<string, number> = {},
): Obj {
  const name = sanitizeName(service.name);
  const named = dedupeBy(service.volumes.filter((v) => v.kind === "named"), (v) => v.name);
  const binds = fixes.bindMountsToPvc
    ? dedupeBy(service.volumes.filter((v) => v.kind === "bind"), (v) => sanitizeName(v.mountPath))
    : [];
  const mounted = [...named, ...binds];
  const initContainers = fixes.addWaitInit ? waitInitContainers(service, firstPorts) : [];
  const container: Obj = {
    name,
    image: service.image ?? "",
    ...(service.command ? { args: service.command } : {}),
    ...(Object.keys(service.environment).length ? { env: envEntries(service) } : {}),
    ...(service.ports.length ? { ports: service.ports.map((p) => ({ containerPort: p.containerPort })) } : {}),
    ...(mounted.length ? { volumeMounts: mounted.map((v) => ({ name: volName(v), mountPath: v.mountPath })) } : {}),
  };
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels: { app: name } },
    spec: {
      replicas: service.replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          ...(initContainers.length ? { initContainers } : {}),
          containers: [container],
          ...(mounted.length
            ? { volumes: mounted.map((v) => ({ name: volName(v), persistentVolumeClaim: { claimName: pvcName(service, v) } })) }
            : {}),
        },
      },
    },
  };
}

export function buildPvc(vol: ComposeVolume, service: ComposeService, namespace: string): Obj {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: pvcName(service, vol), namespace },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
  };
}

export function buildService(service: ComposeService, namespace: string, expose: ConvertFixes["expose"] = "none"): Obj | null {
  if (!service.ports.length) return null;
  const name = sanitizeName(service.name);
  const ports = dedupeBy(service.ports, (p) => String(p.containerPort));
  const hasPublished = service.ports.some((p) => p.publishedPort != null);
  const type = expose === "loadbalancer" && hasPublished ? "LoadBalancer" : "ClusterIP";
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels: { app: name } },
    spec: {
      type,
      selector: { app: name },
      ports: ports.map((p) => ({ name: `p${p.containerPort}`, port: p.containerPort, targetPort: p.containerPort })),
    },
  };
}

export function buildSecret(service: ComposeService, namespace: string): Obj | null {
  const entries = Object.entries(service.environment).filter(([k]) => isSecretEnvKey(k));
  if (!entries.length) return null;
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: sanitizeName(service.name), namespace },
    type: "Opaque",
    stringData: Object.fromEntries(entries),
  };
}

export function buildIngress(services: ComposeService[], namespace: string, host: string): Obj | null {
  const exposed = services.filter((s) => s.image && s.ports.some((p) => p.publishedPort != null));
  if (!exposed.length || !host) return null;
  const single = exposed.length === 1;
  const paths = exposed.map((s) => {
    const name = sanitizeName(s.name);
    const port = s.ports.find((p) => p.publishedPort != null)!.containerPort;
    return {
      path: single ? "/" : `/${name}`,
      pathType: "Prefix",
      backend: { service: { name, port: { number: port } } },
    };
  });
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name: "compose-ingress", namespace },
    spec: { rules: [{ host, http: { paths } }] },
  };
}
