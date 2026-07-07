import { parse as parseYaml } from "yaml";
import { sanitizeName } from "./names";
import type { ComposeModel, ComposeService, ComposePort, ComposeVolume } from "./types";

const UNSUPPORTED_KEYS = ["privileged", "network_mode", "devices", "cap_add", "pid", "userns_mode"];
const IGNORED_TOP_LEVEL = ["configs", "secrets", "networks"];

function toEnvRecord(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(env)) {
    for (const item of env) {
      const s = String(item);
      const eq = s.indexOf("=");
      if (eq === -1) out[s] = "";
      else out[s.slice(0, eq)] = s.slice(eq + 1);
    }
  } else if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      out[k] = v == null ? "" : String(v);
    }
  }
  return out;
}

function validHost(host: number): boolean {
  return Number.isFinite(host) && host > 0;
}

function toPorts(ports: unknown): { ports: ComposePort[]; dropped: boolean } {
  if (!Array.isArray(ports)) return { ports: [], dropped: false };
  const out: ComposePort[] = [];
  let dropped = false;
  for (const p of ports) {
    if (typeof p === "number") {
      out.push({ containerPort: p });
      continue;
    }
    if (typeof p === "string") {
      const bare = p.split("/")[0]!;
      const parts = bare.split(":");
      const container = Number(parts[parts.length - 1]);
      if (!Number.isFinite(container)) {
        dropped = true;
        continue;
      }
      const host = parts.length > 1 ? Number(parts[parts.length - 2]) : NaN;
      out.push(validHost(host) ? { containerPort: container, publishedPort: host } : { containerPort: container });
      continue;
    }
    if (p && typeof p === "object") {
      const obj = p as { target?: number; published?: number | string };
      if (typeof obj.target === "number") {
        const host = obj.published != null ? Number(obj.published) : NaN;
        out.push(validHost(host) ? { containerPort: obj.target, publishedPort: host } : { containerPort: obj.target });
      }
    }
  }
  return { ports: out, dropped };
}

function toDependsOn(dep: unknown): string[] {
  if (Array.isArray(dep)) return dep.map(String);
  if (dep && typeof dep === "object") return Object.keys(dep as Record<string, unknown>);
  return [];
}

function isBindSource(src: string): boolean {
  return src.startsWith(".") || src.startsWith("/") || src.startsWith("~");
}

function toVolumes(volumes: unknown): ComposeVolume[] {
  if (!Array.isArray(volumes)) return [];
  const out: ComposeVolume[] = [];
  for (const v of volumes) {
    if (typeof v === "string") {
      const parts = v.split(":");
      if (parts.length < 2) continue;
      const source = parts[0]!;
      const mountPath = parts[1]!;
      if (isBindSource(source)) {
        out.push({ name: "", mountPath, kind: "bind", source });
      } else {
        out.push({ name: sanitizeName(source), mountPath, kind: "named", source });
      }
      continue;
    }
    if (v && typeof v === "object") {
      const obj = v as { type?: string; source?: string; target?: string };
      if (!obj.target) continue;
      if (obj.type === "bind" || (obj.source && isBindSource(obj.source))) {
        out.push({ name: "", mountPath: obj.target, kind: "bind", source: obj.source ?? "" });
      } else if (obj.source) {
        out.push({ name: sanitizeName(obj.source), mountPath: obj.target, kind: "named", source: obj.source });
      }
    }
  }
  return out;
}

function toCommand(cmd: unknown): string[] | undefined {
  if (typeof cmd === "string") return cmd.length ? cmd.split(/\s+/) : undefined;
  if (Array.isArray(cmd)) return cmd.map(String);
  return undefined;
}

export function parseCompose(text: string): ComposeModel {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  const root = doc && typeof doc === "object" ? doc : {};

  const servicesRoot = root.services;
  const servicesRaw = servicesRoot && typeof servicesRoot === "object" ? (servicesRoot as Record<string, unknown>) : {};
  const services: ComposeService[] = [];
  for (const [name, raw] of Object.entries(servicesRaw)) {
    const svc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const deploy = (svc.deploy as { replicas?: number } | undefined) ?? {};
    const { ports, dropped } = toPorts(svc.ports);
    const unsupported = UNSUPPORTED_KEYS.filter((k) => k in svc);
    if (dropped) unsupported.push("ports");
    services.push({
      name,
      image: typeof svc.image === "string" ? svc.image : undefined,
      ports,
      environment: toEnvRecord(svc.environment),
      volumes: toVolumes(svc.volumes),
      command: toCommand(svc.command),
      replicas: typeof deploy.replicas === "number" ? deploy.replicas : 1,
      dependsOn: toDependsOn(svc.depends_on),
      unsupported,
    });
  }

  const ignoredTopLevel = IGNORED_TOP_LEVEL.filter((k) => k in root);
  return { services, ignoredTopLevel };
}
