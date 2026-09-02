import { useEffect, useMemo } from "react";
import { detectIssues, rollUpIssues } from "@rigel/k8s/src/issues/engine";
import type { Issue, IssueGroup, IssueInput, RawObject } from "@rigel/k8s/src/issues/types";
import { subscribe, unsubscribe } from "@/lib/ws";
import { useCluster, type KindAccess } from "@/store/cluster";

/** Every watch the detection rules read. Watched cluster-wide so a lookup
 *  collection is never narrower than the collection referencing it. */
export const ISSUE_KINDS = [
  "pods",
  "deployments",
  "statefulsets",
  "daemonsets",
  "jobs",
  "nodes",
  "events",
  "ingresses",
  "services",
  "endpoints",
  "configmaps",
  "secrets",
  "serviceaccounts",
  "validatingwebhookconfigurations",
  "mutatingwebhookconfigurations",
  "apiservices",
  "persistentvolumeclaims",
  "persistentvolumes",
  "storageclasses",
  "resourcequotas",
  "certificates.cert-manager.io",
  "orders.acme.cert-manager.io",
  "challenges.acme.cert-manager.io",
] as const;

export type IssueKind = (typeof ISSUE_KINDS)[number];

/** The namespace bar is a client-side filter, so every issue watch is cluster-wide. */
export const ISSUE_WATCH_NAMESPACE = "*";

const KIND_FIELDS: Record<IssueKind, keyof IssueInput> = {
  pods: "pods",
  deployments: "deployments",
  statefulsets: "statefulsets",
  daemonsets: "daemonsets",
  jobs: "jobs",
  nodes: "nodes",
  events: "events",
  ingresses: "ingresses",
  services: "services",
  endpoints: "endpoints",
  configmaps: "configmaps",
  secrets: "secrets",
  serviceaccounts: "serviceaccounts",
  validatingwebhookconfigurations: "validatingwebhookconfigurations",
  mutatingwebhookconfigurations: "mutatingwebhookconfigurations",
  apiservices: "apiservices",
  persistentvolumeclaims: "persistentvolumeclaims",
  persistentvolumes: "persistentvolumes",
  storageclasses: "storageclasses",
  resourcequotas: "resourcequotas",
  "certificates.cert-manager.io": "certificates",
  "orders.acme.cert-manager.io": "orders",
  "challenges.acme.cert-manager.io": "challenges",
};

/** Adapt the cluster store's `resources` into `IssueInput`. A kind the store has
 *  never seen, or one this connection may not watch, stays `undefined` rather than
 *  `[]`, so the reference rules skip it instead of reporting every reference to it
 *  as dangling. */
export function buildIssueInput(
  resources: Record<string, Record<string, unknown>>,
  accessByKind?: Record<string, KindAccess>,
): IssueInput {
  const input: IssueInput = {};
  for (const kind of ISSUE_KINDS) {
    const slice = resources[kind];
    if (!slice) continue;
    const access = accessByKind?.[kind];
    if (access && access.status !== "ok") continue;
    input[KIND_FIELDS[kind]] = Object.values(slice) as RawObject[];
  }
  return input;
}

export interface UseIssuesResult {
  issues: Issue[];
  groups: IssueGroup[];
  loading: boolean;
  updatedAt: Date;
}

/** Subscribe every issue watch and detect the cluster's live problems. */
export function useIssues(): UseIssuesResult {
  const resources = useCluster((s) => s.resources);
  const accessByKind = useCluster((s) => s.accessByKind);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const loading = useCluster((s) => s.isLoading);

  useEffect(() => {
    for (const kind of ISSUE_KINDS) subscribe(kind, ISSUE_WATCH_NAMESPACE);
    return () => {
      for (const kind of ISSUE_KINDS) unsubscribe(kind, ISSUE_WATCH_NAMESPACE);
    };
  }, []);

  const detected = useMemo(
    () => detectIssues(buildIssueInput(resources, accessByKind)),
    [resources, accessByKind],
  );

  const scoped = useMemo(
    () =>
      namespaceFilter
        ? detected.filter(
            (i) => i.subject.namespace === "" || i.subject.namespace === namespaceFilter,
          )
        : detected,
    [detected, namespaceFilter],
  );

  const groups = useMemo(() => rollUpIssues(scoped), [scoped]);
  const updatedAt = useMemo(() => new Date(), [scoped]);

  return { issues: scoped, groups, loading, updatedAt };
}
