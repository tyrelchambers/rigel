import type {
  Order, Challenge, OrderNode, ChallengeNode, IssuerRef,
} from "@/panels/certificates/types";

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
    challenges: challenges
      .filter((ch) => byUid(ch.metadata.ownerReferences, order.metadata.uid))
      .map(challengeNode),
    createdAt: order.metadata.creationTimestamp,
  };
}
