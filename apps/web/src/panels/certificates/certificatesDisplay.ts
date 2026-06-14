import type {
  Certificate, CertificateRequest, Order, Challenge,
  CertView, RequestNode, OrderNode, ChallengeNode, Condition,
} from "./types";

// Re-export the shared relativeAge so the panel imports one age formatter.
export { relativeAge } from "../pods/podDisplay";

const CERT_NAME_ANNOTATION = "cert-manager.io/certificate-name";

function condition(conds: Condition[] | undefined, type: string): Condition | undefined {
  return (conds ?? []).find((c) => c.type === type);
}

/** True when the Ready condition is "True". */
export function isReady(cert: Certificate): boolean {
  return condition(cert.status?.conditions, "Ready")?.status === "True";
}

/** True when the Issuing condition is "True". */
export function isIssuing(cert: Certificate): boolean {
  return condition(cert.status?.conditions, "Issuing")?.status === "True";
}

/** "kind/name" or "—" when unset. */
export function issuerLabel(cert: Certificate): string {
  const ref = cert.spec?.issuerRef;
  if (!ref?.name) return "—";
  return ref.kind ? `${ref.kind}/${ref.name}` : ref.name;
}

function byUid(refs: { uid: string }[] | undefined, uid: string): boolean {
  return (refs ?? []).some((r) => r.uid === uid);
}

function newestFirst<T extends { metadata: { creationTimestamp?: string; name: string } }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ta = a.metadata.creationTimestamp ?? "";
    const tb = b.metadata.creationTimestamp ?? "";
    if (ta !== tb) return tb.localeCompare(ta);
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

function challengeNode(ch: Challenge): ChallengeNode {
  return {
    name: ch.metadata.name,
    namespace: ch.metadata.namespace,
    type: ch.spec?.type ?? "—",
    dnsName: ch.spec?.dnsName ?? "—",
    state: ch.status?.state ?? "—",
    reason: ch.status?.reason ?? "",
  };
}

function orderNode(order: Order, challenges: Challenge[]): OrderNode {
  return {
    name: order.metadata.name,
    namespace: order.metadata.namespace,
    state: order.status?.state ?? "—",
    reason: order.status?.reason ?? "",
    challenges: challenges
      .filter((ch) => byUid(ch.metadata.ownerReferences, order.metadata.uid))
      .map(challengeNode),
  };
}

function requestNode(cr: CertificateRequest, orders: Order[], challenges: Challenge[]): RequestNode {
  const order = orders.find((o) => byUid(o.metadata.ownerReferences, cr.metadata.uid)) ?? null;
  const ready = condition(cr.status?.conditions, "Ready");
  return {
    name: cr.metadata.name,
    namespace: cr.metadata.namespace,
    ready: ready?.status === "True",
    reason: ready?.reason ?? ready?.message ?? "",
    order: order ? orderNode(order, challenges) : null,
  };
}

/** Join certs ← requests ← orders ← challenges into per-cert view models. */
export function buildCertViews(
  certs: Certificate[],
  requests: CertificateRequest[],
  orders: Order[],
  challenges: Challenge[],
): CertView[] {
  return certs.map((cert) => {
    const myReqs = newestFirst(
      requests.filter(
        (cr) =>
          cr.metadata.namespace === cert.metadata.namespace &&
          cr.metadata.annotations?.[CERT_NAME_ANNOTATION] === cert.metadata.name,
      ),
    );
    return {
      cert,
      name: cert.metadata.name,
      namespace: cert.metadata.namespace,
      uid: cert.metadata.uid,
      ready: isReady(cert),
      issuing: isIssuing(cert) || myReqs.some((r) => condition(r.status?.conditions, "Ready")?.status !== "True"),
      dnsNames: cert.spec?.dnsNames ?? [],
      issuer: issuerLabel(cert),
      secretName: cert.spec?.secretName ?? "",
      notAfter: cert.status?.notAfter,
      requests: myReqs.map((cr) => requestNode(cr, orders, challenges)),
    };
  });
}

/** Case-insensitive match on name, namespace, and dnsNames. */
export function matchesSearch(v: CertView, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return (
    v.name.toLowerCase().includes(q) ||
    (v.namespace ?? "").toLowerCase().includes(q) ||
    v.dnsNames.some((d) => d.toLowerCase().includes(q))
  );
}

/** Sort by namespace then name. */
export function sortCertViews(views: CertView[]): CertView[] {
  return [...views].sort((a, b) => {
    const na = a.namespace ?? "";
    const nb = b.namespace ?? "";
    if (na !== nb) return na.localeCompare(nb);
    return a.name.localeCompare(b.name);
  });
}
