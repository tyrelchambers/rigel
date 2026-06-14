// cert-manager resource shapes for the web Certificates panel. Net-new (no Swift
// equivalent). All four kinds are namespace-scoped. We only type the fields the
// panel reads — k8s objects carry far more.

export interface OwnerReference {
  uid: string;
  kind: string;
  name: string;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  creationTimestamp?: string; // ISO 8601
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  ownerReferences?: OwnerReference[];
}

export interface Condition {
  type: string;   // "Ready" | "Issuing" | "Approved" | "Valid" | ...
  status: string; // "True" | "False" | "Unknown"
  reason?: string;
  message?: string;
}

export interface IssuerRef {
  name?: string;
  kind?: string; // "Issuer" | "ClusterIssuer"
  group?: string;
}

export interface Certificate {
  metadata: ObjectMeta;
  spec?: {
    dnsNames?: string[];
    secretName?: string;
    issuerRef?: IssuerRef;
  };
  status?: {
    conditions?: Condition[];
    notAfter?: string;     // ISO 8601
    notBefore?: string;
    renewalTime?: string;
  };
}

export interface CertificateRequest {
  metadata: ObjectMeta;
  status?: { conditions?: Condition[] };
}

export interface Order {
  metadata: ObjectMeta;
  status?: { state?: string; reason?: string };
}

export interface Challenge {
  metadata: ObjectMeta;
  spec?: { type?: string; dnsName?: string }; // type: "HTTP-01" | "DNS-01"
  status?: { state?: string; reason?: string; processing?: boolean; presented?: boolean };
}

/** A challenge node in the rendered chain. */
export interface ChallengeNode {
  name: string;
  namespace?: string;
  type: string;    // "HTTP-01" / "DNS-01" / "—"
  dnsName: string;
  state: string;   // status.state or "—"
  reason: string;
}

/** An order node, with its challenges. */
export interface OrderNode {
  name: string;
  namespace?: string;
  state: string;
  reason: string;
  challenges: ChallengeNode[];
}

/** A certificate request node, with its order (if any). */
export interface RequestNode {
  name: string;
  namespace?: string;
  ready: boolean;
  reason: string;
  order: OrderNode | null;
}

/** One certificate's full view model: row data + issuance chain. */
export interface CertView {
  cert: Certificate;
  name: string;
  namespace?: string;
  uid: string;
  ready: boolean;
  issuing: boolean;
  dnsNames: string[];
  issuer: string;       // "kind/name" or "—"
  secretName: string;   // "" when unset
  notAfter?: string;
  requests: RequestNode[]; // newest-first
}
