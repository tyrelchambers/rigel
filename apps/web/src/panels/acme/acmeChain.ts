import type {
  Order, Challenge, OrderNode, ChallengeNode, IssuerRef,
  Certificate, CertificateRequest,
} from "@/panels/certificates/types";
import type { SortOption } from "@/panels/components/PanelSort";
import type { StatusBadgeVariant } from "@/panels/components/StatusBadge";

export const CERT_NAME_ANNOTATION = "cert-manager.io/certificate-name";

export function issuerRefLabel(ref: IssuerRef | undefined): string {
  if (!ref?.name) return "—";
  return ref.kind ? `${ref.kind}/${ref.name}` : ref.name;
}

export function byUid(refs: { uid: string }[] | undefined, uid: string): boolean {
  return (refs ?? []).some((r) => r.uid === uid);
}

export function challengeNode(ch: Challenge): ChallengeNode {
  return {
    name: ch.metadata.name,
    namespace: ch.metadata.namespace,
    uid: ch.metadata.uid,
    type: ch.spec?.type ?? "—",
    dnsName: ch.spec?.dnsName ?? "—",
    token: ch.spec?.token ?? "—",
    state: ch.status?.state ?? "—",
    reason: ch.status?.reason ?? "",
    createdAt: ch.metadata.creationTimestamp,
  };
}

export function orderNode(order: Order, challenges: Challenge[]): OrderNode {
  return {
    name: order.metadata.name,
    namespace: order.metadata.namespace,
    uid: order.metadata.uid,
    issuer: issuerRefLabel(order.spec?.issuerRef),
    state: order.status?.state ?? "—",
    reason: order.status?.reason ?? "",
    dnsNames: order.spec?.dnsNames ?? [],
    challenges: challenges
      .filter((ch) => byUid(ch.metadata.ownerReferences, order.metadata.uid))
      .map(challengeNode),
    createdAt: order.metadata.creationTimestamp,
  };
}

export function certificateForOrder(
  order: Order,
  requests: CertificateRequest[],
  certs: Certificate[],
): { name: string; namespace?: string; uid?: string } | null {
  const request = requests.find((r) => byUid(order.metadata.ownerReferences, r.metadata.uid));
  const name = request?.metadata.annotations?.[CERT_NAME_ANNOTATION];
  if (!name) return null;
  const namespace = order.metadata.namespace;
  const cert = certs.find((c) => c.metadata.namespace === namespace && c.metadata.name === name);
  return { name, namespace, uid: cert?.metadata.uid };
}

export interface OrderRow extends OrderNode {
  certificate: { name: string; namespace?: string; uid?: string } | null;
}

export function buildOrderRows(
  orders: Order[],
  challenges: Challenge[],
  requests: CertificateRequest[],
  certs: Certificate[],
): OrderRow[] {
  return orders.map((order) => ({
    ...orderNode(order, challenges),
    certificate: certificateForOrder(order, requests, certs),
  }));
}

export function matchesOrderSearch(row: OrderRow, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (query === "") return true;
  return (
    row.name.toLowerCase().includes(query) ||
    (row.namespace ?? "").toLowerCase().includes(query) ||
    (row.certificate?.name ?? "").toLowerCase().includes(query) ||
    row.state.toLowerCase().includes(query) ||
    row.reason.toLowerCase().includes(query)
  );
}

export function matchesChallengeSearch(node: ChallengeNode, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (query === "") return true;
  return (
    node.name.toLowerCase().includes(query) ||
    (node.namespace ?? "").toLowerCase().includes(query) ||
    node.dnsName.toLowerCase().includes(query) ||
    node.type.toLowerCase().includes(query) ||
    node.state.toLowerCase().includes(query) ||
    node.reason.toLowerCase().includes(query)
  );
}

const ACME_STATE_BUCKETS: Record<string, string[]> = {
  active: ["pending", "processing"],
  failed: ["invalid", "errored", "expired"],
  valid: ["valid", "ready"],
};

export function matchesAcmeState(state: string, filter: string): boolean {
  if (filter === "all") return true;
  const bucket = ACME_STATE_BUCKETS[filter];
  if (!bucket) return false;
  return bucket.includes(state.toLowerCase());
}

export function acmeStateVariant(state: string): StatusBadgeVariant {
  switch (state.toLowerCase()) {
    case "valid":
    case "ready":
      return "healthy";
    case "pending":
    case "processing":
      return "pending";
    case "invalid":
    case "errored":
    case "expired":
      return "error";
    default:
      return "neutral";
  }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const byNamespaceThenName = (a: { namespace?: string; name: string }, b: { namespace?: string; name: string }) =>
  (a.namespace ?? "").localeCompare(b.namespace ?? "") || byName(a, b);
const byState = (a: { state: string; name: string }, b: { state: string; name: string }) =>
  a.state.localeCompare(b.state) || byName(a, b);
const ageMs = (n: { createdAt?: string }) => Date.parse(n.createdAt ?? "") || 0;
const byAge = (a: { createdAt?: string; name: string }, b: { createdAt?: string; name: string }) =>
  ageMs(a) - ageMs(b) || byName(a, b);

export function orderSortOptions(): SortOption<OrderRow>[] {
  return [
    { value: "namespace", label: "Namespace", compare: byNamespaceThenName },
    { value: "name", label: "Name", compare: byName },
    { value: "state", label: "State", compare: byState },
    { value: "age", label: "Age", compare: byAge },
  ];
}

export function challengeSortOptions(): SortOption<ChallengeNode>[] {
  return [
    { value: "namespace", label: "Namespace", compare: byNamespaceThenName },
    { value: "name", label: "Name", compare: byName },
    { value: "state", label: "State", compare: byState },
    { value: "type", label: "Type", compare: (a, b) => a.type.localeCompare(b.type) || byName(a, b) },
    { value: "age", label: "Age", compare: byAge },
  ];
}
