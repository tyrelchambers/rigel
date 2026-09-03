import type { Severity } from "../auditCommon";

export type IssueSeverity = Severity;

export type IssueCategory =
  | "runtime"
  | "scheduling"
  | "networking"
  | "config"
  | "storage"
  | "controlPlane"
  | "certs";

export type IssueRuleId =
  | "crashLoopBackOff"
  | "imagePullBackOff"
  | "oomKilled"
  | "podFailed"
  | "restartStorm"
  | "initContainerStuck"
  | "degradedDeployment"
  | "degradedStatefulSet"
  | "degradedDaemonSet"
  | "zeroReplicas"
  | "jobBackoffLimitExceeded"
  | "podUnschedulable"
  | "podEvicted"
  | "nodeNotReady"
  | "nodePressure"
  | "ingressBackendServiceMissing"
  | "ingressBackendPortMissing"
  | "ingressTlsSecretMissing"
  | "serviceNoEndpoints"
  | "missingConfigMapRef"
  | "missingSecretRef"
  | "missingPvcRef"
  | "missingServiceAccount"
  | "webhookBackendMissing"
  | "apiServiceUnavailable"
  | "pvcUnbound"
  | "pvcMissingStorageClass"
  | "pvFailed"
  | "pvReleased"
  | "resourceQuotaExhausted"
  | "certificateNotReady"
  | "certificateExpiringSoon"
  | "acmeOrderFailed"
  | "acmeChallengeStuck"
  | "helmReleaseFailed"
  | "agentIncident";

export interface IssueSubject {
  kind: string;
  namespace: string;
  name: string;
}

export interface IssueFix {
  label: string;
  destructive: boolean;
  command: string[];
}

export interface Issue {
  fingerprint: string;
  rule: IssueRuleId;
  title: string;
  category: IssueCategory;
  severity: IssueSeverity;
  subject: IssueSubject;
  cause: string;
  whatsWrong: string;
  nextStep: string;
  evidence?: string;
  onsetAt?: string;
  related: IssueSubject[];
  fix?: IssueFix;
  source: "cluster" | "agent";
}

export interface IssueGroup {
  key: string;
  lead: Issue;
  members: Issue[];
}

export type RawObject = Record<string, any>;

export interface IssueInput {
  pods?: RawObject[];
  deployments?: RawObject[];
  statefulsets?: RawObject[];
  daemonsets?: RawObject[];
  jobs?: RawObject[];
  nodes?: RawObject[];
  events?: RawObject[];
  ingresses?: RawObject[];
  services?: RawObject[];
  endpoints?: RawObject[];
  configmaps?: RawObject[];
  secrets?: RawObject[];
  serviceaccounts?: RawObject[];
  validatingwebhookconfigurations?: RawObject[];
  mutatingwebhookconfigurations?: RawObject[];
  apiservices?: RawObject[];
  persistentvolumeclaims?: RawObject[];
  persistentvolumes?: RawObject[];
  storageclasses?: RawObject[];
  resourcequotas?: RawObject[];
  certificates?: RawObject[];
  orders?: RawObject[];
  challenges?: RawObject[];
  helmReleases?: RawObject[];
}

export function issueFingerprint(i: Issue): string {
  return [i.rule, i.subject.kind, i.subject.namespace, i.subject.name, i.cause].join("|");
}

export function subjectKey(s: IssueSubject): string {
  return `${s.namespace}/${s.name}`;
}
