import { differenceInDays, differenceInMinutes, parseISO } from "date-fns";
import type { Issue, IssueInput, IssueSubject, RawObject } from "../types";

const CERT_EXPIRY_WARN_DAYS = 14;
const CHALLENGE_STUCK_MINUTES = 30;
const READY_CONDITION = "Ready";
const FAILED_ORDER_STATES = new Set(["errored", "invalid"]);
const PENDING_CHALLENGE_STATE = "pending";
const FAILED_RELEASE_STATUSES = new Set([
  "failed",
  "pending-install",
  "pending-upgrade",
  "pending-rollback",
]);

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function subjectOf(kind: string, o: RawObject): IssueSubject {
  return {
    kind,
    namespace: textOf(o.metadata?.namespace) ?? "",
    name: textOf(o.metadata?.name) ?? "",
  };
}

function conditionOf(o: RawObject, type: string): RawObject | undefined {
  const conditions = o.status?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  return (conditions as RawObject[]).find((c) => c?.type === type);
}

function certificateNotReady(cert: RawObject): Issue | undefined {
  const ready = conditionOf(cert, READY_CONDITION);
  if (!ready || ready.status === "True") return undefined;
  const subject = subjectOf("Certificate", cert);
  return {
    fingerprint: "",
    rule: "certificateNotReady",
    title: "Certificate not ready",
    category: "certs",
    severity: "warning",
    subject,
    cause: "Certificate is not ready",
    whatsWrong: `Certificate ${subject.namespace}/${subject.name} reports its Ready condition as ${ready.status}, so the TLS secret it backs is missing or stale.`,
    nextStep: "Follow the certificate's request, order and challenge chain to the step that is not completing.",
    evidence: textOf(ready.message),
    onsetAt: textOf(ready.lastTransitionTime),
    related: [],
    source: "cluster",
  };
}

function certificateExpiringSoon(cert: RawObject, now: Date): Issue | undefined {
  const notAfter = textOf(cert.status?.notAfter);
  if (!notAfter) return undefined;
  const daysLeft = differenceInDays(parseISO(notAfter), now);
  if (Number.isNaN(daysLeft) || daysLeft > CERT_EXPIRY_WARN_DAYS) return undefined;
  const subject = subjectOf("Certificate", cert);
  return {
    fingerprint: "",
    rule: "certificateExpiringSoon",
    title: "Certificate expiring soon",
    category: "certs",
    severity: "warning",
    subject,
    cause: "Certificate is close to expiry",
    whatsWrong: `Certificate ${subject.namespace}/${subject.name} stops being valid at ${notAfter} and has not been renewed yet.`,
    nextStep: "Check the issuer and the certificate's order chain so cert-manager can renew it.",
    related: [],
    source: "cluster",
  };
}

function acmeOrderFailed(order: RawObject): Issue | undefined {
  const state = textOf(order.status?.state);
  if (!state || !FAILED_ORDER_STATES.has(state)) return undefined;
  const subject = subjectOf("Order", order);
  return {
    fingerprint: "",
    rule: "acmeOrderFailed",
    title: "ACME order failed",
    category: "certs",
    severity: "critical",
    subject,
    cause: "ACME order ended in a failed state",
    whatsWrong: `Order ${subject.namespace}/${subject.name} finished in state ${state}, so the ACME authority refused to issue this certificate.`,
    nextStep: "Read the order's reason, fix what the authority rejected, then delete the order so cert-manager retries.",
    evidence: textOf(order.status?.reason),
    related: [],
    source: "cluster",
  };
}

function acmeChallengeStuck(challenge: RawObject, now: Date): Issue | undefined {
  if (textOf(challenge.status?.state) !== PENDING_CHALLENGE_STATE) return undefined;
  const created = textOf(challenge.metadata?.creationTimestamp);
  if (!created) return undefined;
  const pendingMinutes = differenceInMinutes(now, parseISO(created));
  if (Number.isNaN(pendingMinutes) || pendingMinutes <= CHALLENGE_STUCK_MINUTES) return undefined;
  const subject = subjectOf("Challenge", challenge);
  return {
    fingerprint: "",
    rule: "acmeChallengeStuck",
    title: "ACME challenge stuck",
    category: "certs",
    severity: "warning",
    subject,
    cause: "ACME challenge has been pending too long",
    whatsWrong: `Challenge ${subject.namespace}/${subject.name} has been pending for more than ${CHALLENGE_STUCK_MINUTES} minutes, so the ACME authority is not seeing the response it asked for.`,
    nextStep: "Confirm the DNS record or HTTP path the challenge presents is reachable from the public internet.",
    evidence: textOf(challenge.status?.reason),
    onsetAt: created,
    related: [],
    source: "cluster",
  };
}

function helmReleaseFailed(release: RawObject): Issue | undefined {
  const status = textOf(release.status);
  if (!status || !FAILED_RELEASE_STATUSES.has(status)) return undefined;
  const subject: IssueSubject = {
    kind: "HelmRelease",
    namespace: textOf(release.namespace) ?? "",
    name: textOf(release.name) ?? "",
  };
  return {
    fingerprint: "",
    rule: "helmReleaseFailed",
    title: "Helm release not deployed",
    category: "config",
    severity: "critical",
    subject,
    cause: "Helm release is not deployed",
    whatsWrong: `Helm release ${subject.namespace}/${subject.name} is in the ${status} state, so its chart is not fully applied.`,
    nextStep: "Roll the release back to its last deployed revision, or fix the chart values and upgrade again.",
    related: [],
    source: "cluster",
  };
}

function collect<T>(items: RawObject[] | undefined, rule: (o: RawObject) => T | undefined): T[] {
  const out: T[] = [];
  for (const item of items ?? []) {
    const result = rule(item);
    if (result) out.push(result);
  }
  return out;
}

/** Certificate, ACME and Helm issues over raw kubectl JSON. Pure: no client, no IO. */
export function certRules(input: IssueInput, now: Date = new Date()): Issue[] {
  return [
    ...collect(input.certificates, certificateNotReady),
    ...collect(input.certificates, (c) => certificateExpiringSoon(c, now)),
    ...collect(input.orders, acmeOrderFailed),
    ...collect(input.challenges, (c) => acmeChallengeStuck(c, now)),
    ...collect(input.helmReleases, helmReleaseFailed),
  ];
}
