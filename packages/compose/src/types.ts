export interface ComposePort {
  containerPort: number;
  publishedPort?: number;
}

export interface ComposeVolume {
  name: string;
  mountPath: string;
  kind: "named" | "bind";
  source: string;
}

export interface ComposeService {
  name: string;
  image?: string;
  ports: ComposePort[];
  environment: Record<string, string>;
  volumes: ComposeVolume[];
  command?: string[];
  replicas: number;
  dependsOn: string[];
  unsupported: string[];
}

export interface ComposeModel {
  services: ComposeService[];
  ignoredTopLevel: string[];
}

export type Severity = "info" | "warning";

export interface WarningFix {
  label: string;
  option: "emitSecrets" | "bindMountsToPvc" | "expose" | "addWaitInit";
}

export interface Warning {
  severity: Severity;
  service?: string;
  directive?: string;
  message: string;
  fix?: WarningFix;
}

export interface CatalogHint {
  service: string;
  appId: string;
  appName: string;
}

export interface ManifestDoc {
  kind: string;
  name: string;
  yaml: string;
}

export interface ConversionResult {
  manifests: ManifestDoc[];
  warnings: Warning[];
  catalogHints: CatalogHint[];
}

export interface ConvertFixes {
  emitSecrets?: boolean;
  bindMountsToPvc?: boolean;
  expose?: "none" | "loadbalancer" | "ingress";
  ingressHost?: string;
  addWaitInit?: boolean;
}

export interface ConvertOptions {
  namespace: string;
  fixes?: ConvertFixes;
}
