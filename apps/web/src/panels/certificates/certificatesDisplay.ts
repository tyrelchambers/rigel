import type {
  Certificate, CertificateRequest, Order, Challenge,
  CertView, RequestNode, OrderNode, ChallengeNode, Condition,
} from "./types";

// Re-export the shared relativeAge so the panel imports one age formatter.
export { relativeAge } from "../pods/podDisplay";

/** Largest sensible unit for a duration in seconds ("344d" / "3h" / "5m" / "5s"). */
function compactDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Future-aware expiry label for a certificate `notAfter` timestamp. Unlike the
 * past-only `relativeAge`, this distinguishes "not yet expired" from "already
 * expired":
 *   - undefined / unparseable → "—"
 *   - future  → "in 344d", "in 3h", "in 5m", "in 5s"
 *   - past    → "expired 5m ago", "expired 2d ago"
 * Unit thresholds mirror `relativeAge` (s < 60, m < 3600, h < 86400, else d).
 */
export function expiryLabel(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const dt = (then - now) / 1000; // seconds until expiry (negative once expired)
  if (dt >= 0) return `in ${compactDuration(dt)}`;
  return `expired ${compactDuration(-dt)} ago`;
}

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

// ---------------------------------------------------------------------------
// Spelled-out duration helpers for the card UI.
// ---------------------------------------------------------------------------

/** Singular/plural helper for a unit name. */
function pluralize(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Converts a number of seconds into the largest spelled-out unit:
 * "62 days", "3 hours", "5 minutes", "45 seconds".
 */
function spelledDuration(seconds: number): string {
  const s = Math.floor(Math.abs(seconds));
  if (s < 60) return pluralize(s, "second");
  if (s < 3600) return pluralize(Math.floor(s / 60), "minute");
  if (s < 86400) return pluralize(Math.floor(s / 3600), "hour");
  return pluralize(Math.floor(s / 86400), "day");
}

/**
 * Full expiry phrase for the card header right group:
 *   "Expires in 62 days" | "Expired 5 days ago" | "" (if missing/invalid).
 */
export function expiresPhrase(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const dt = (then - now) / 1000;
  if (dt >= 0) return `Expires in ${spelledDuration(dt)}`;
  return `Expired ${spelledDuration(-dt)} ago`;
}

/**
 * Age phrase for the DETAILS row:
 *   "Created 27 days ago" | "" (if missing/invalid).
 */
export function agePhrase(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const dt = (now - then) / 1000;
  if (dt < 0) return `Created 0 seconds ago`;
  return `Created ${spelledDuration(dt)} ago`;
}

/**
 * Short relative phrase for the NOT AFTER detail value:
 *   "in 62 days" | "expired 5 days ago" | "—" (if missing/invalid).
 */
export function notAfterRelative(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const dt = (then - now) / 1000;
  if (dt >= 0) return `in ${spelledDuration(dt)}`;
  return `expired ${spelledDuration(-dt)} ago`;
}

/**
 * Absolute date string for the secondary NOT AFTER text:
 *   "Aug 20, 2026" | "—" (if missing/invalid).
 * Uses UTC to avoid timezone shifts for certificate validity dates.
 */
export function absoluteDate(iso: string | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  return then.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
