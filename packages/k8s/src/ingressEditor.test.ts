import { test, expect } from "vitest";
import {
  ingressToInput,
  buildIngressYAML,
  canSubmitIngress,
  blankRule,
  type IngressInput,
  type IngressLike,
} from "./ingressEditor";

const FULL: IngressInput = {
  name: "web",
  namespace: "default",
  ingressClassName: "nginx",
  annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
  labels: { app: "web" },
  rules: [{ host: "helmsman.sh", paths: [{ path: "/", pathType: "Prefix", serviceName: "marketing", servicePort: "80" }] }],
  tls: [{ hosts: "helmsman.sh", secretName: "web-tls" }],
};

test("buildIngressYAML: full manifest with class, annotations, labels, TLS, rule", () => {
  expect(buildIngressYAML(FULL)).toBe(
    `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: default
  labels:
    app: web
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - helmsman.sh
      secretName: web-tls
  rules:
    - host: helmsman.sh
      http:
        paths:
          - path: "/"
            pathType: Prefix
            backend:
              service:
                name: marketing
                port:
                  number: 80
`,
  );
});

test("buildIngressYAML: omits empty sections (no class/tls/labels/annotations)", () => {
  const yaml = buildIngressYAML({
    name: "bare",
    namespace: "apps",
    ingressClassName: "",
    annotations: {},
    labels: {},
    rules: [{ host: "", paths: [{ path: "/api", pathType: "Prefix", serviceName: "api", servicePort: "8080" }] }],
    tls: [],
  });
  expect(yaml).not.toContain("labels:");
  expect(yaml).not.toContain("annotations:");
  expect(yaml).not.toContain("ingressClassName:");
  expect(yaml).not.toContain("tls:");
  expect(yaml).toContain("    -\n      http:"); // hostless rule
  expect(yaml).toContain("number: 8080");
});

test("buildIngressYAML: named service port emits a name, numeric emits a number", () => {
  const named = buildIngressYAML({ ...FULL, tls: [], rules: [{ host: "x", paths: [{ path: "/", pathType: "Prefix", serviceName: "svc", servicePort: "http" }] }] });
  expect(named).toContain("port:\n                  name: http");
  const numeric = buildIngressYAML({ ...FULL, tls: [], rules: [{ host: "x", paths: [{ path: "/", pathType: "Prefix", serviceName: "svc", servicePort: "443" }] }] });
  expect(numeric).toContain("port:\n                  number: 443");
});

test("buildIngressYAML: skips half-filled paths and empty rules", () => {
  const yaml = buildIngressYAML({
    ...FULL,
    tls: [],
    rules: [
      { host: "a.com", paths: [{ path: "/", pathType: "Prefix", serviceName: "", servicePort: "" }] }, // host only, no complete path → kept (host)
      { host: "", paths: [{ path: "/x", pathType: "Prefix", serviceName: "", servicePort: "" }] }, // nothing complete, no host → dropped
    ],
  });
  expect(yaml).toContain("- host: a.com");
  expect(yaml).not.toContain("/x");
});

test("ingressToInput: extracts fields, strips last-applied-configuration, joins TLS hosts", () => {
  const live: IngressLike = {
    metadata: {
      name: "web",
      namespace: "default",
      labels: { app: "web" },
      annotations: {
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        "kubectl.kubernetes.io/last-applied-configuration": "{...}",
      },
    },
    spec: {
      ingressClassName: "nginx",
      rules: [{ host: "helmsman.sh", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "marketing", port: { number: 80 } } } }] } }],
      tls: [{ hosts: ["helmsman.sh", "www.helmsman.sh"], secretName: "web-tls" }],
    },
  };
  const input = ingressToInput(live);
  expect(input.annotations).toEqual({ "cert-manager.io/cluster-issuer": "letsencrypt-prod" });
  expect(input.labels).toEqual({ app: "web" });
  expect(input.ingressClassName).toBe("nginx");
  expect(input.rules[0]!.paths[0]).toEqual({ path: "/", pathType: "Prefix", serviceName: "marketing", servicePort: "80" });
  expect(input.tls[0]!.hosts).toBe("helmsman.sh, www.helmsman.sh");
});

test("ingressToInput → buildIngressYAML round-trips a named port", () => {
  const live: IngressLike = {
    metadata: { name: "api", namespace: "apps" },
    spec: { rules: [{ host: "api.x", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "api", port: { name: "http" } } } }] } }] },
  };
  const yaml = buildIngressYAML(ingressToInput(live));
  expect(yaml).toContain("name: api");
  expect(yaml).toContain("port:\n                  name: http");
});

test("canSubmitIngress: requires a name and at least one complete path; rejects half-filled", () => {
  expect(canSubmitIngress(FULL)).toBe(true);
  expect(canSubmitIngress({ ...FULL, name: "  " })).toBe(false);
  // half-filled path (service but no port)
  expect(canSubmitIngress({ ...FULL, rules: [{ host: "x", paths: [{ path: "/", pathType: "Prefix", serviceName: "svc", servicePort: "" }] }] })).toBe(false);
  // no complete path anywhere
  expect(canSubmitIngress({ ...FULL, rules: [blankRule()] })).toBe(false);
});
