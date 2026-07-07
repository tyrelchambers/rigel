import { sanitizeName } from "./names";
import { isSecretEnvKey } from "./env";
import type { ComposeService, ComposeVolume } from "./types";

type Obj = Record<string, any>;

function pvcName(service: ComposeService, vol: ComposeVolume): string {
  return `${sanitizeName(service.name)}-${sanitizeName(vol.name || vol.mountPath)}`;
}

function envEntries(service: ComposeService): Obj[] {
  const secretName = sanitizeName(service.name);
  return Object.entries(service.environment).map(([name, value]) =>
    isSecretEnvKey(name)
      ? { name, valueFrom: { secretKeyRef: { name: secretName, key: name } } }
      : { name, value },
  );
}

export function buildDeployment(service: ComposeService, namespace: string): Obj {
  const name = sanitizeName(service.name);
  const named = service.volumes.filter((v) => v.kind === "named");
  const container: Obj = {
    name,
    image: service.image ?? "",
    ...(service.command ? { args: service.command } : {}),
    ...(Object.keys(service.environment).length ? { env: envEntries(service) } : {}),
    ...(service.ports.length ? { ports: service.ports.map((p) => ({ containerPort: p.containerPort })) } : {}),
    ...(named.length ? { volumeMounts: named.map((v) => ({ name: v.name, mountPath: v.mountPath })) } : {}),
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
          containers: [container],
          ...(named.length
            ? { volumes: named.map((v) => ({ name: v.name, persistentVolumeClaim: { claimName: pvcName(service, v) } })) }
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

export function buildService(service: ComposeService, namespace: string): Obj | null {
  if (!service.ports.length) return null;
  const name = sanitizeName(service.name);
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels: { app: name } },
    spec: {
      type: "ClusterIP",
      selector: { app: name },
      ports: service.ports.map((p) => ({ name: `p${p.containerPort}`, port: p.containerPort, targetPort: p.containerPort })),
    },
  };
}
