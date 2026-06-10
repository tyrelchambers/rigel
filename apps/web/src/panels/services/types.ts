// Service type for the web Services panel. Mirrors the Swift `Service` in
// `Sources/Helmsman/Cluster/KubeTypes.swift` and the normative spec in
// `docs/parity/services.md`. Services are namespace-scoped.
//
// NOTE: in the raw kubectl `-o json` watch stream, `targetPort` is an
// IntOrString — a JSON number (e.g. 8080) or a string (e.g. "http"). The Swift
// app decodes both into `AnyKubeIntOrString.stringValue`; on web we keep the
// raw `number | string` and stringify in the display helpers.

export interface ServicePort {
  name?: string;
  port: number;
  targetPort?: number | string;
  protocol?: string; // "TCP" | "UDP" | "SCTP"
  nodePort?: number;
}

export interface ServiceSpec {
  type?: string; // "ClusterIP" | "NodePort" | "LoadBalancer" | "ExternalName"
  clusterIP?: string;
  selector?: Record<string, string>;
  ports?: ServicePort[];
  externalName?: string;
  externalIPs?: string[];
}

export interface LoadBalancerIngress {
  ip?: string;
  hostname?: string;
}

export interface ServiceStatus {
  loadBalancer?: {
    ingress?: LoadBalancerIngress[];
  };
}

export interface Service {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601
    labels?: Record<string, string>;
  };
  spec?: ServiceSpec;
  status?: ServiceStatus;
}
