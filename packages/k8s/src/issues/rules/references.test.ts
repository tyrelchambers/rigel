import { describe, it, expect } from "vitest";
import { referenceRules } from "./references";
import type { RawObject } from "../types";

function ingress(over: RawObject = {}): RawObject {
  return {
    metadata: { name: "web", namespace: "default" },
    spec: {
      rules: [
        {
          host: "example.com",
          http: {
            paths: [{ path: "/", backend: { service: { name: "web-svc", port: { number: 8000 } } } }],
          },
        },
      ],
    },
    ...over,
  };
}

function service(over: RawObject = {}): RawObject {
  return {
    metadata: { name: "web-svc", namespace: "default" },
    spec: { type: "ClusterIP", ports: [{ port: 8000 }] },
    ...over,
  };
}

function pod(spec: RawObject): RawObject {
  return { metadata: { name: "api-0", namespace: "default" }, spec };
}

describe("ingressBackendServiceMissing", () => {
  it("fires when the backend Service does not exist", () => {
    const out = referenceRules({ ingresses: [ingress()], services: [] });
    expect(out.map((i) => i.rule)).toEqual(["ingressBackendServiceMissing"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({ kind: "Ingress", namespace: "default", name: "web" });
    expect(out[0].related).toEqual([{ kind: "Service", namespace: "default", name: "web-svc" }]);
    expect(out[0].fingerprint).toBe("");
    expect(out[0].evidence).toBeUndefined();
    expect(out[0].onsetAt).toBeUndefined();
  });

  it("fires when a defaultBackend Service does not exist", () => {
    const out = referenceRules({
      ingresses: [
        {
          metadata: { name: "web", namespace: "default" },
          spec: { defaultBackend: { service: { name: "fallback", port: { number: 80 } } } },
        },
      ],
      services: [],
    });
    expect(out.map((i) => i.rule)).toEqual(["ingressBackendServiceMissing"]);
    expect(out[0].related).toEqual([{ kind: "Service", namespace: "default", name: "fallback" }]);
  });

  it("does not fire when the Service exists and exposes the port", () => {
    const out = referenceRules({ ingresses: [ingress()], services: [service()] });
    expect(out).toEqual([]);
  });

  it("does not fire for a resource backend", () => {
    const out = referenceRules({
      ingresses: [
        {
          metadata: { name: "web", namespace: "default" },
          spec: {
            rules: [
              {
                http: {
                  paths: [
                    { path: "/", backend: { resource: { kind: "StorageBucket", name: "assets" } } },
                  ],
                },
              },
            ],
          },
        },
      ],
      services: [],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when services were not watched", () => {
    expect(referenceRules({ ingresses: [ingress()] })).toEqual([]);
  });
});

describe("ingressBackendPortMissing", () => {
  it("fires when the Service exists but does not expose the numbered port", () => {
    const out = referenceRules({
      ingresses: [ingress()],
      services: [service({ spec: { type: "ClusterIP", ports: [{ port: 80 }] } })],
    });
    expect(out.map((i) => i.rule)).toEqual(["ingressBackendPortMissing"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].related).toContainEqual({ kind: "Service", namespace: "default", name: "web-svc" });
  });

  it("fires when the Service does not expose the named port", () => {
    const out = referenceRules({
      ingresses: [
        ingress({
          spec: {
            rules: [
              {
                http: {
                  paths: [{ backend: { service: { name: "web-svc", port: { name: "https" } } } }],
                },
              },
            ],
          },
        }),
      ],
      services: [service({ spec: { type: "ClusterIP", ports: [{ name: "http", port: 8000 }] } })],
    });
    expect(out.map((i) => i.rule)).toEqual(["ingressBackendPortMissing"]);
  });

  it("does not fire when the named port matches", () => {
    const out = referenceRules({
      ingresses: [
        ingress({
          spec: {
            rules: [
              {
                http: {
                  paths: [{ backend: { service: { name: "web-svc", port: { name: "http" } } } }],
                },
              },
            ],
          },
        }),
      ],
      services: [service({ spec: { type: "ClusterIP", ports: [{ name: "http", port: 8000 }] } })],
    });
    expect(out).toEqual([]);
  });

  it("does not match a named port against a port number", () => {
    const out = referenceRules({
      ingresses: [
        ingress({
          spec: {
            rules: [
              {
                http: {
                  paths: [{ backend: { service: { name: "web-svc", port: { name: "8000" } } } }],
                },
              },
            ],
          },
        }),
      ],
      services: [service({ spec: { type: "ClusterIP", ports: [{ name: "http", port: 8000 }] } })],
    });
    expect(out.map((i) => i.rule)).toEqual(["ingressBackendPortMissing"]);
  });

  it("does not fire when services were not watched", () => {
    expect(referenceRules({ ingresses: [ingress()] })).toEqual([]);
  });
});

describe("ingressTlsSecretMissing", () => {
  const tlsIngress = ingress({
    spec: {
      tls: [{ hosts: ["example.com"], secretName: "web-tls" }],
      rules: [],
    },
  });

  it("fires when the TLS Secret does not exist", () => {
    const out = referenceRules({ ingresses: [tlsIngress], secrets: [] });
    expect(out.map((i) => i.rule)).toEqual(["ingressTlsSecretMissing"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].related).toEqual([{ kind: "Secret", namespace: "default", name: "web-tls" }]);
  });

  it("does not fire when the TLS Secret exists", () => {
    const out = referenceRules({
      ingresses: [tlsIngress],
      secrets: [{ metadata: { name: "web-tls", namespace: "default" } }],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when secrets were not watched", () => {
    expect(referenceRules({ ingresses: [tlsIngress] })).toEqual([]);
  });
});

describe("serviceNoEndpoints", () => {
  const selectorService = service({
    metadata: { name: "api", namespace: "default" },
    spec: { type: "ClusterIP", selector: { app: "api" }, ports: [{ port: 80 }] },
  });

  it("fires for a selector Service with no ready addresses", () => {
    const out = referenceRules({
      services: [selectorService],
      endpoints: [{ metadata: { name: "api", namespace: "default" }, subsets: [] }],
    });
    expect(out.map((i) => i.rule)).toEqual(["serviceNoEndpoints"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].subject).toEqual({ kind: "Service", namespace: "default", name: "api" });
  });

  it("fires for a selector Service with no Endpoints object at all", () => {
    const out = referenceRules({ services: [selectorService], endpoints: [] });
    expect(out.map((i) => i.rule)).toEqual(["serviceNoEndpoints"]);
  });

  it("does not fire when the Endpoints object has a ready address", () => {
    const out = referenceRules({
      services: [selectorService],
      endpoints: [
        {
          metadata: { name: "api", namespace: "default" },
          subsets: [{ addresses: [{ ip: "10.42.0.7" }], ports: [{ port: 80 }] }],
        },
      ],
    });
    expect(out).toEqual([]);
  });

  it("does not count not-ready addresses as ready", () => {
    const out = referenceRules({
      services: [selectorService],
      endpoints: [
        {
          metadata: { name: "api", namespace: "default" },
          subsets: [{ notReadyAddresses: [{ ip: "10.42.0.7" }], ports: [{ port: 80 }] }],
        },
      ],
    });
    expect(out.map((i) => i.rule)).toEqual(["serviceNoEndpoints"]);
  });

  it("does not fire for a selectorless Service", () => {
    const out = referenceRules({
      services: [{ metadata: { name: "external", namespace: "default" }, spec: { ports: [{ port: 80 }] } }],
      endpoints: [],
    });
    expect(out).toEqual([]);
  });

  it("does not fire for an ExternalName Service", () => {
    const out = referenceRules({
      services: [
        {
          metadata: { name: "ext", namespace: "default" },
          spec: { type: "ExternalName", selector: { app: "x" }, externalName: "db.example.com" },
        },
      ],
      endpoints: [],
    });
    expect(out).toEqual([]);
  });

  it("does not fire for a headless Service with no selector", () => {
    const out = referenceRules({
      services: [
        {
          metadata: { name: "headless", namespace: "default" },
          spec: { clusterIP: "None", ports: [{ port: 80 }] },
        },
      ],
      endpoints: [],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when endpoints were not watched", () => {
    expect(referenceRules({ services: [selectorService] })).toEqual([]);
  });
});

describe("missingConfigMapRef", () => {
  const envFromPod = pod({
    containers: [{ name: "api", envFrom: [{ configMapRef: { name: "app-config" } }] }],
  });

  it("fires on an envFrom configMapRef with no ConfigMap", () => {
    const out = referenceRules({ pods: [envFromPod], configmaps: [] });
    expect(out.map((i) => i.rule)).toEqual(["missingConfigMapRef"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({ kind: "Pod", namespace: "default", name: "api-0" });
    expect(out[0].related).toEqual([{ kind: "ConfigMap", namespace: "default", name: "app-config" }]);
  });

  it("fires on a configMap volume with no ConfigMap", () => {
    const out = referenceRules({
      pods: [pod({ containers: [], volumes: [{ name: "cfg", configMap: { name: "app-config" } }] })],
      configmaps: [],
    });
    expect(out.map((i) => i.rule)).toEqual(["missingConfigMapRef"]);
  });

  it("fires on an initContainer configMapKeyRef with no ConfigMap", () => {
    const out = referenceRules({
      pods: [
        pod({
          initContainers: [
            { name: "init", env: [{ name: "MODE", valueFrom: { configMapKeyRef: { name: "app-config", key: "mode" } } }] },
          ],
        }),
      ],
      configmaps: [],
    });
    expect(out.map((i) => i.rule)).toEqual(["missingConfigMapRef"]);
  });

  it("reports one issue per pod listing every missing ConfigMap", () => {
    const out = referenceRules({
      pods: [
        pod({
          containers: [
            {
              name: "api",
              envFrom: [{ configMapRef: { name: "app-config" } }, { configMapRef: { name: "extra-config" } }],
            },
          ],
        }),
      ],
      configmaps: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].related).toEqual([
      { kind: "ConfigMap", namespace: "default", name: "app-config" },
      { kind: "ConfigMap", namespace: "default", name: "extra-config" },
    ]);
  });

  it("does not fire when the ref is optional", () => {
    const out = referenceRules({
      pods: [
        pod({
          containers: [
            {
              name: "api",
              envFrom: [{ configMapRef: { name: "app-config", optional: true } }],
              env: [{ name: "MODE", valueFrom: { configMapKeyRef: { name: "other", key: "mode", optional: true } } }],
            },
          ],
          volumes: [{ name: "cfg", configMap: { name: "third", optional: true } }],
        }),
      ],
      configmaps: [],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when the ConfigMap exists", () => {
    const out = referenceRules({
      pods: [envFromPod],
      configmaps: [{ metadata: { name: "app-config", namespace: "default" } }],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when configmaps were not watched", () => {
    expect(referenceRules({ pods: [envFromPod] })).toEqual([]);
  });
});

describe("missingSecretRef", () => {
  const secretKeyPod = pod({
    containers: [
      { name: "api", env: [{ name: "TOKEN", valueFrom: { secretKeyRef: { name: "api-token", key: "token" } } }] },
    ],
  });

  it("fires on a secretKeyRef with no Secret", () => {
    const out = referenceRules({ pods: [secretKeyPod], secrets: [] });
    expect(out.map((i) => i.rule)).toEqual(["missingSecretRef"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].related).toEqual([{ kind: "Secret", namespace: "default", name: "api-token" }]);
  });

  it("fires on a secret volume with no Secret", () => {
    const out = referenceRules({
      pods: [pod({ containers: [], volumes: [{ name: "creds", secret: { secretName: "api-token" } }] })],
      secrets: [],
    });
    expect(out.map((i) => i.rule)).toEqual(["missingSecretRef"]);
  });

  it("fires on an imagePullSecrets entry with no Secret", () => {
    const out = referenceRules({
      pods: [pod({ containers: [], imagePullSecrets: [{ name: "ghcr-creds" }] })],
      secrets: [],
    });
    expect(out.map((i) => i.rule)).toEqual(["missingSecretRef"]);
    expect(out[0].related).toEqual([{ kind: "Secret", namespace: "default", name: "ghcr-creds" }]);
  });

  it("does not fire when the ref is optional", () => {
    const out = referenceRules({
      pods: [
        pod({
          containers: [
            {
              name: "api",
              envFrom: [{ secretRef: { name: "api-token", optional: true } }],
              env: [{ name: "TOKEN", valueFrom: { secretKeyRef: { name: "other", key: "token", optional: true } } }],
            },
          ],
          volumes: [{ name: "creds", secret: { secretName: "third", optional: true } }],
        }),
      ],
      secrets: [],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when the Secret exists", () => {
    const out = referenceRules({
      pods: [secretKeyPod],
      secrets: [{ metadata: { name: "api-token", namespace: "default" } }],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when secrets were not watched", () => {
    expect(referenceRules({ pods: [secretKeyPod] })).toEqual([]);
  });
});

describe("missingPvcRef", () => {
  const claimPod = pod({
    containers: [],
    volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-api-0" } }],
  });

  it("fires when the PersistentVolumeClaim does not exist", () => {
    const out = referenceRules({ pods: [claimPod], persistentvolumeclaims: [] });
    expect(out.map((i) => i.rule)).toEqual(["missingPvcRef"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].related).toEqual([
      { kind: "PersistentVolumeClaim", namespace: "default", name: "data-api-0" },
    ]);
  });

  it("does not fire when the claim exists", () => {
    const out = referenceRules({
      pods: [claimPod],
      persistentvolumeclaims: [{ metadata: { name: "data-api-0", namespace: "default" } }],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when claims were not watched", () => {
    expect(referenceRules({ pods: [claimPod] })).toEqual([]);
  });
});

describe("missingServiceAccount", () => {
  const saPod = pod({ containers: [], serviceAccountName: "deployer" });

  it("fires when the ServiceAccount does not exist", () => {
    const out = referenceRules({ pods: [saPod], serviceaccounts: [] });
    expect(out.map((i) => i.rule)).toEqual(["missingServiceAccount"]);
    expect(out[0].severity).toBe("warning");
    expect(out[0].related).toEqual([
      { kind: "ServiceAccount", namespace: "default", name: "deployer" },
    ]);
  });

  it("does not fire when the ServiceAccount exists", () => {
    const out = referenceRules({
      pods: [saPod],
      serviceaccounts: [{ metadata: { name: "deployer", namespace: "default" } }],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when service accounts were not watched", () => {
    expect(referenceRules({ pods: [saPod] })).toEqual([]);
  });
});

describe("webhookBackendMissing", () => {
  const validating = {
    metadata: { name: "cert-manager-webhook" },
    webhooks: [
      {
        name: "webhook.cert-manager.io",
        clientConfig: { service: { name: "cert-manager-webhook", namespace: "cert-manager", path: "/validate" } },
      },
    ],
  };

  it("fires when a validating webhook backend Service is missing", () => {
    const out = referenceRules({ validatingwebhookconfigurations: [validating], services: [] });
    expect(out.map((i) => i.rule)).toEqual(["webhookBackendMissing"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({
      kind: "ValidatingWebhookConfiguration",
      namespace: "",
      name: "cert-manager-webhook",
    });
    expect(out[0].related).toEqual([
      { kind: "Service", namespace: "cert-manager", name: "cert-manager-webhook" },
    ]);
  });

  it("fires when a mutating webhook backend Service is missing", () => {
    const out = referenceRules({
      mutatingwebhookconfigurations: [
        {
          metadata: { name: "sidecar-injector" },
          webhooks: [{ name: "inject.io", clientConfig: { service: { name: "injector", namespace: "istio-system" } } }],
        },
      ],
      services: [],
    });
    expect(out.map((i) => i.rule)).toEqual(["webhookBackendMissing"]);
    expect(out[0].subject.kind).toBe("MutatingWebhookConfiguration");
  });

  it("does not fire when the backend Service exists", () => {
    const out = referenceRules({
      validatingwebhookconfigurations: [validating],
      services: [{ metadata: { name: "cert-manager-webhook", namespace: "cert-manager" }, spec: {} }],
    });
    expect(out).toEqual([]);
  });

  it("does not fire for a url backend", () => {
    const out = referenceRules({
      validatingwebhookconfigurations: [
        {
          metadata: { name: "external-hook" },
          webhooks: [{ name: "hook.io", clientConfig: { url: "https://hooks.example.com/validate" } }],
        },
      ],
      services: [],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when services were not watched", () => {
    expect(referenceRules({ validatingwebhookconfigurations: [validating] })).toEqual([]);
  });
});

describe("apiServiceUnavailable", () => {
  const apiservice = {
    metadata: { name: "v1beta1.metrics.k8s.io" },
    spec: { service: { name: "metrics-server", namespace: "kube-system" } },
    status: {
      conditions: [
        {
          type: "Available",
          status: "False",
          reason: "FailedDiscoveryCheck",
          message: "failing or missing response from https://10.42.0.9:4443/apis/metrics.k8s.io/v1beta1",
          lastTransitionTime: "2026-02-01T12:00:00Z",
        },
      ],
    },
  };

  it("fires when the Available condition is False", () => {
    const out = referenceRules({ apiservices: [apiservice] });
    expect(out.map((i) => i.rule)).toEqual(["apiServiceUnavailable"]);
    expect(out[0].severity).toBe("critical");
    expect(out[0].subject).toEqual({ kind: "APIService", namespace: "", name: "v1beta1.metrics.k8s.io" });
    expect(out[0].evidence).toBe(
      "failing or missing response from https://10.42.0.9:4443/apis/metrics.k8s.io/v1beta1",
    );
    expect(out[0].onsetAt).toBe("2026-02-01T12:00:00Z");
    expect(out[0].related).toEqual([
      { kind: "Service", namespace: "kube-system", name: "metrics-server" },
    ]);
  });

  it("does not fire when the Available condition is True", () => {
    const out = referenceRules({
      apiservices: [
        {
          metadata: { name: "v1beta1.metrics.k8s.io" },
          status: { conditions: [{ type: "Available", status: "True" }] },
        },
      ],
    });
    expect(out).toEqual([]);
  });

  it("does not fire when apiservices were not watched", () => {
    expect(referenceRules({})).toEqual([]);
  });
});
