// Ingress type for the web Ingresses panel. Mirrors the Swift `Ingress` in
// `Sources/Helmsman/Cluster/KubeTypes.swift` and the normative spec in
// `docs/parity/ingresses.md`. Ingresses are namespace-scoped.

export interface ServiceBackendPort {
  number?: number;
  name?: string;
}

export interface IngressServiceBackend {
  name: string;
  port?: ServiceBackendPort;
}

export interface IngressBackend {
  service?: IngressServiceBackend;
}

export interface IngressPath {
  path?: string;
  pathType?: string; // "Prefix" | "Exact" | "ImplementationSpecific"
  backend: IngressBackend;
}

export interface IngressHTTP {
  paths: IngressPath[];
}

export interface IngressRule {
  host?: string;
  http?: IngressHTTP;
}

export interface IngressTLS {
  hosts?: string[];
  secretName?: string;
}

export interface IngressLoadBalancerIngress {
  ip?: string;
  hostname?: string;
}

export interface IngressSpec {
  ingressClassName?: string;
  rules?: IngressRule[];
  tls?: IngressTLS[];
  defaultBackend?: IngressBackend;
}

export interface IngressStatus {
  loadBalancer?: {
    ingress?: IngressLoadBalancerIngress[];
  };
}

export interface Ingress {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601
    labels?: Record<string, string> | null;
    annotations?: Record<string, string> | null;
  };
  spec?: IngressSpec;
  status?: IngressStatus;
}

/** Flattened routing rule for display: host/path → service:port. */
export interface IngressRoute {
  host: string;
  path: string;
  service: string;
  port: string;
}
