import type {
  Issue,
  IssueCategory,
  IssueInput,
  IssueRuleId,
  IssueSeverity,
  IssueSubject,
  RawObject,
} from "../types";

const AVAILABLE_CONDITION = "Available";
const EXTERNAL_NAME_TYPE = "ExternalName";

type NameIndex = Map<string, RawObject> | null;

interface PodRefSpec {
  rule: IssueRuleId;
  kind: string;
  title: string;
  category: IssueCategory;
  severity: IssueSeverity;
  refs: (pod: RawObject) => string[];
  index: (input: IssueInput) => NameIndex;
}

interface PortMiss {
  service: IssueSubject;
  port: string;
}

function arrayOf(value: unknown): RawObject[] {
  return Array.isArray(value) ? (value as RawObject[]) : [];
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function refKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

function subjectOf(kind: string, o: RawObject): IssueSubject {
  return {
    kind,
    namespace: textOf(o.metadata?.namespace) ?? "",
    name: textOf(o.metadata?.name) ?? "",
  };
}

export function nameIndex(objs: RawObject[] | undefined): NameIndex {
  if (!objs) return null;
  return new Map(
    objs.map((o) => [refKey(textOf(o.metadata?.namespace) ?? "", textOf(o.metadata?.name) ?? ""), o]),
  );
}

function conditionOf(o: RawObject, type: string): RawObject | undefined {
  return arrayOf(o.status?.conditions).find((c) => c?.type === type);
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

function quoted(names: string[]): string {
  return names.map((n) => `"${n}"`).join(", ");
}

function relatedOf(kind: string, namespace: string, names: string[]): IssueSubject[] {
  return names.map((name) => ({ kind, namespace, name }));
}

function containersOf(pod: RawObject): RawObject[] {
  return [pod.spec?.containers, pod.spec?.initContainers, pod.spec?.ephemeralContainers].flatMap(
    arrayOf,
  );
}

function required(ref: RawObject | undefined): boolean {
  return Boolean(ref) && ref?.optional !== true;
}

function configMapRefs(pod: RawObject): string[] {
  const names: string[] = [];
  for (const container of containersOf(pod)) {
    for (const source of arrayOf(container.envFrom)) {
      if (required(source?.configMapRef)) names.push(source.configMapRef.name);
    }
    for (const env of arrayOf(container.env)) {
      const ref = env?.valueFrom?.configMapKeyRef;
      if (required(ref)) names.push(ref.name);
    }
  }
  for (const volume of arrayOf(pod.spec?.volumes)) {
    if (required(volume?.configMap)) names.push(volume.configMap.name);
  }
  return names.filter((name) => typeof name === "string" && name.length > 0);
}

function secretRefs(pod: RawObject): string[] {
  const names: string[] = [];
  for (const container of containersOf(pod)) {
    for (const source of arrayOf(container.envFrom)) {
      if (required(source?.secretRef)) names.push(source.secretRef.name);
    }
    for (const env of arrayOf(container.env)) {
      const ref = env?.valueFrom?.secretKeyRef;
      if (required(ref)) names.push(ref.name);
    }
  }
  for (const volume of arrayOf(pod.spec?.volumes)) {
    if (required(volume?.secret)) names.push(volume.secret.secretName);
  }
  for (const pull of arrayOf(pod.spec?.imagePullSecrets)) {
    if (pull?.name) names.push(pull.name);
  }
  return names.filter((name) => typeof name === "string" && name.length > 0);
}

function claimRefs(pod: RawObject): string[] {
  const names: string[] = [];
  for (const volume of arrayOf(pod.spec?.volumes)) {
    const claim = textOf(volume?.persistentVolumeClaim?.claimName);
    if (claim) names.push(claim);
  }
  return names;
}

function serviceAccountRefs(pod: RawObject): string[] {
  const name = textOf(pod.spec?.serviceAccountName) ?? textOf(pod.spec?.serviceAccount);
  return name ? [name] : [];
}

const POD_REF_SPECS: PodRefSpec[] = [
  {
    rule: "missingConfigMapRef",
    kind: "ConfigMap",
    title: "Missing ConfigMap",
    category: "config",
    severity: "critical",
    refs: configMapRefs,
    index: (input) => nameIndex(input.configmaps),
  },
  {
    rule: "missingSecretRef",
    kind: "Secret",
    title: "Missing Secret",
    category: "config",
    severity: "critical",
    refs: secretRefs,
    index: (input) => nameIndex(input.secrets),
  },
  {
    rule: "missingPvcRef",
    kind: "PersistentVolumeClaim",
    title: "Missing volume claim",
    category: "storage",
    severity: "critical",
    refs: claimRefs,
    index: (input) => nameIndex(input.persistentvolumeclaims),
  },
  {
    rule: "missingServiceAccount",
    kind: "ServiceAccount",
    title: "Missing service account",
    category: "config",
    severity: "warning",
    refs: serviceAccountRefs,
    index: (input) => nameIndex(input.serviceaccounts),
  },
];

function podRefIssues(input: IssueInput, spec: PodRefSpec): Issue[] {
  const index = spec.index(input);
  if (!index) return [];
  const issues: Issue[] = [];
  for (const pod of input.pods ?? []) {
    const subject = subjectOf("Pod", pod);
    const missing = unique(spec.refs(pod)).filter(
      (name) => !index.has(refKey(subject.namespace, name)),
    );
    if (missing.length === 0) continue;
    const many = missing.length > 1;
    issues.push({
      fingerprint: "",
      rule: spec.rule,
      title: spec.title,
      category: spec.category,
      severity: spec.severity,
      subject,
      cause: `Referenced ${spec.kind} does not exist`,
      whatsWrong: `Pod ${subject.namespace}/${subject.name} references ${spec.kind}${many ? "s" : ""} ${quoted(missing)}, which ${many ? "do" : "does"} not exist in namespace ${subject.namespace}.`,
      nextStep: `Create the missing ${spec.kind} or point the pod at one that exists.`,
      related: relatedOf(spec.kind, subject.namespace, missing),
      source: "cluster",
    });
  }
  return issues;
}

function ingressBackends(ingress: RawObject): RawObject[] {
  const backends: RawObject[] = [];
  if (ingress.spec?.defaultBackend) backends.push(ingress.spec.defaultBackend);
  for (const rule of arrayOf(ingress.spec?.rules)) {
    for (const path of arrayOf(rule?.http?.paths)) {
      if (path?.backend) backends.push(path.backend);
    }
  }
  return backends;
}

function backendPortLabel(port: RawObject | undefined): string | undefined {
  if (textOf(port?.name)) return port!.name;
  if (typeof port?.number === "number") return String(port.number);
  return undefined;
}

function exposesBackendPort(svc: RawObject, port: RawObject | undefined): boolean {
  const ports = arrayOf(svc.spec?.ports);
  if (ports.length === 0) return true;
  const named = textOf(port?.name);
  if (named) return ports.some((p) => p?.name === named);
  if (typeof port?.number === "number") return ports.some((p) => p?.port === port.number);
  return true;
}

function ingressBackendServiceMissing(ingress: RawObject, services: Map<string, RawObject>): Issue | undefined {
  const subject = subjectOf("Ingress", ingress);
  const missing = unique(
    ingressBackends(ingress)
      .map((backend) => textOf(backend?.service?.name))
      .filter((name): name is string => Boolean(name)),
  ).filter((name) => !services.has(refKey(subject.namespace, name)));
  if (missing.length === 0) return undefined;
  const many = missing.length > 1;
  return {
    fingerprint: "",
    rule: "ingressBackendServiceMissing",
    title: "Ingress backend missing",
    category: "networking",
    severity: "critical",
    subject,
    cause: "Ingress backend Service does not exist",
    whatsWrong: `Ingress ${subject.namespace}/${subject.name} routes to Service${many ? "s" : ""} ${quoted(missing)}, which ${many ? "do" : "does"} not exist in namespace ${subject.namespace}, so those routes cannot reach anything.`,
    nextStep: "Create the backend Service or point the ingress rule at a Service that exists.",
    related: relatedOf("Service", subject.namespace, missing),
    source: "cluster",
  };
}

function ingressBackendPortMissing(ingress: RawObject, services: Map<string, RawObject>): Issue | undefined {
  const subject = subjectOf("Ingress", ingress);
  const misses: PortMiss[] = [];
  const seen = new Set<string>();
  for (const backend of ingressBackends(ingress)) {
    const name = textOf(backend?.service?.name);
    if (!name) continue;
    const svc = services.get(refKey(subject.namespace, name));
    if (!svc) continue;
    const label = backendPortLabel(backend.service.port);
    if (!label) continue;
    if (exposesBackendPort(svc, backend.service.port)) continue;
    const key = refKey(name, label);
    if (seen.has(key)) continue;
    seen.add(key);
    misses.push({ service: { kind: "Service", namespace: subject.namespace, name }, port: label });
  }
  if (misses.length === 0) return undefined;
  const many = misses.length > 1;
  const phrases = misses.map(
    (m) => `port ${m.port} on Service ${m.service.namespace}/${m.service.name}`,
  );
  return {
    fingerprint: "",
    rule: "ingressBackendPortMissing",
    title: "Ingress backend port missing",
    category: "networking",
    severity: "critical",
    subject,
    cause: "Ingress backend port is not exposed by the Service",
    whatsWrong: `Ingress ${subject.namespace}/${subject.name} routes to ${phrases.join(", ")}, but ${many ? "those Services expose none of those ports" : "that Service does not expose it"}.`,
    nextStep: "Add the port to the Service or change the ingress backend to a port the Service exposes.",
    related: misses.map((m) => m.service),
    source: "cluster",
  };
}

function ingressTlsSecretMissing(ingress: RawObject, secrets: Map<string, RawObject>): Issue | undefined {
  const subject = subjectOf("Ingress", ingress);
  const missing = unique(
    arrayOf(ingress.spec?.tls)
      .map((tls) => textOf(tls?.secretName))
      .filter((name): name is string => Boolean(name)),
  ).filter((name) => !secrets.has(refKey(subject.namespace, name)));
  if (missing.length === 0) return undefined;
  const many = missing.length > 1;
  return {
    fingerprint: "",
    rule: "ingressTlsSecretMissing",
    title: "Ingress TLS secret missing",
    category: "networking",
    severity: "critical",
    subject,
    cause: "Ingress TLS Secret does not exist",
    whatsWrong: `Ingress ${subject.namespace}/${subject.name} terminates TLS with Secret${many ? "s" : ""} ${quoted(missing)}, which ${many ? "do" : "does"} not exist in namespace ${subject.namespace}, so it cannot serve a certificate.`,
    nextStep: "Create the TLS Secret or issue the certificate that fills it.",
    related: relatedOf("Secret", subject.namespace, missing),
    source: "cluster",
  };
}

function readyAddressCount(endpoints: RawObject): number {
  return arrayOf(endpoints.subsets).reduce(
    (total, subset) => total + arrayOf(subset?.addresses).length,
    0,
  );
}

function serviceNoEndpoints(svc: RawObject, endpoints: Map<string, RawObject>): Issue | undefined {
  if (svc.spec?.type === EXTERNAL_NAME_TYPE) return undefined;
  const selector = svc.spec?.selector;
  if (!selector || Object.keys(selector).length === 0) return undefined;
  const subject = subjectOf("Service", svc);
  const found = endpoints.get(refKey(subject.namespace, subject.name));
  if (found && readyAddressCount(found) > 0) return undefined;
  return {
    fingerprint: "",
    rule: "serviceNoEndpoints",
    title: "Service has no endpoints",
    category: "networking",
    severity: "warning",
    subject,
    cause: "Service has no ready endpoints",
    whatsWrong: `Service ${subject.namespace}/${subject.name} selects no ready pods, so traffic sent to it has nowhere to go.`,
    nextStep: "Check that pods matching the service selector exist and are passing their readiness probes.",
    related: [],
    source: "cluster",
  };
}

function webhookBackendMissing(
  config: RawObject,
  kind: string,
  services: Map<string, RawObject>,
): Issue | undefined {
  const subject = subjectOf(kind, config);
  const missing: IssueSubject[] = [];
  const seen = new Set<string>();
  for (const webhook of arrayOf(config.webhooks)) {
    const backend = webhook?.clientConfig?.service;
    const name = textOf(backend?.name);
    if (!name) continue;
    const namespace = textOf(backend.namespace) ?? "";
    const key = refKey(namespace, name);
    if (services.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push({ kind: "Service", namespace, name });
  }
  if (missing.length === 0) return undefined;
  const many = missing.length > 1;
  const names = missing.map((m) => `${m.namespace}/${m.name}`);
  return {
    fingerprint: "",
    rule: "webhookBackendMissing",
    title: "Webhook backend missing",
    category: "controlPlane",
    severity: "critical",
    subject,
    cause: "Webhook backend Service does not exist",
    whatsWrong: `${kind} ${subject.name} calls Service${many ? "s" : ""} ${quoted(names)}, which ${many ? "do" : "does"} not exist, so the requests this webhook guards may be rejected.`,
    nextStep: "Restore the webhook's backend Service or remove the webhook configuration that points at it.",
    related: missing,
    source: "cluster",
  };
}

function apiServiceUnavailable(apiservice: RawObject): Issue | undefined {
  const condition = conditionOf(apiservice, AVAILABLE_CONDITION);
  if (condition?.status !== "False") return undefined;
  const subject = subjectOf("APIService", apiservice);
  const backend = apiservice.spec?.service;
  const backendName = textOf(backend?.name);
  return {
    fingerprint: "",
    rule: "apiServiceUnavailable",
    title: "API service unavailable",
    category: "controlPlane",
    severity: "critical",
    subject,
    cause: "APIService is not available",
    whatsWrong: `APIService ${subject.name} reports its Available condition as False, so calls to the API group it serves fail.`,
    nextStep: "Check the pods behind the APIService backing service and the API server's network path to them.",
    evidence: textOf(condition.message),
    onsetAt: textOf(condition.lastTransitionTime),
    related: backendName
      ? [{ kind: "Service", namespace: textOf(backend.namespace) ?? "", name: backendName }]
      : [],
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

/** Dangling-reference issues over raw kubectl JSON. Pure: no client, no IO. */
export function referenceRules(input: IssueInput): Issue[] {
  const services = nameIndex(input.services);
  const secrets = nameIndex(input.secrets);
  const endpoints = nameIndex(input.endpoints);
  return [
    ...(services ? collect(input.ingresses, (i) => ingressBackendServiceMissing(i, services)) : []),
    ...(services ? collect(input.ingresses, (i) => ingressBackendPortMissing(i, services)) : []),
    ...(secrets ? collect(input.ingresses, (i) => ingressTlsSecretMissing(i, secrets)) : []),
    ...(endpoints ? collect(input.services, (s) => serviceNoEndpoints(s, endpoints)) : []),
    ...POD_REF_SPECS.flatMap((spec) => podRefIssues(input, spec)),
    ...(services
      ? collect(input.validatingwebhookconfigurations, (c) =>
          webhookBackendMissing(c, "ValidatingWebhookConfiguration", services),
        )
      : []),
    ...(services
      ? collect(input.mutatingwebhookconfigurations, (c) =>
          webhookBackendMissing(c, "MutatingWebhookConfiguration", services),
        )
      : []),
    ...collect(input.apiservices, apiServiceUnavailable),
  ];
}
