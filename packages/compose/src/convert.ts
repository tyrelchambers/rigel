import { stringify as stringifyYaml } from "yaml";
import { parseCompose } from "./parse";
import { buildDeployment, buildPvc, buildService } from "./resources";
import { catalogHints } from "./hints";
import { isSecretEnvKey } from "./env";
import type { ConversionResult, ConvertOptions, ManifestDoc, Warning } from "./types";

function doc(obj: Record<string, any>): ManifestDoc {
  return { kind: obj.kind, name: obj.metadata?.name ?? "", yaml: stringifyYaml(obj) };
}

export function convert(composeText: string, opts: ConvertOptions): ConversionResult {
  const model = parseCompose(composeText);
  const manifests: ManifestDoc[] = [];
  const warnings: Warning[] = [];

  for (const key of model.ignoredTopLevel) {
    warnings.push({ severity: "info", directive: key, message: `Top-level "${key}" is not translated and was ignored.` });
  }

  for (const service of model.services) {
    if (!service.image) {
      warnings.push({ severity: "warning", service: service.name, message: `Service "${service.name}" has no image; skipped.` });
      continue;
    }

    manifests.push(doc(buildDeployment(service, opts.namespace)));

    const svcObj = buildService(service, opts.namespace);
    if (svcObj) manifests.push(doc(svcObj));

    for (const vol of service.volumes) {
      if (vol.kind === "named") {
        manifests.push(doc(buildPvc(vol, service, opts.namespace)));
      } else {
        warnings.push({
          severity: "warning",
          service: service.name,
          directive: "volumes",
          message: `Host bind mount "${vol.source}:${vol.mountPath}" is not translated. Use a PVC or configure storage manually.`,
        });
      }
    }

    for (const p of service.ports) {
      if (p.publishedPort != null) {
        warnings.push({
          severity: "info",
          service: service.name,
          directive: "ports",
          message: `Published port ${p.publishedPort}:${p.containerPort} became a ClusterIP Service. To expose it outside the cluster, add an Ingress.`,
        });
      }
    }

    for (const name of Object.keys(service.environment)) {
      if (isSecretEnvKey(name)) {
        warnings.push({
          severity: "warning",
          service: service.name,
          directive: name,
          message: `Env "${name}" looks like a secret and now references Secret "${service.name}". Create that Secret before applying.`,
        });
      }
    }

    if (service.replicas > 1 && service.volumes.some((v) => v.kind === "named")) {
      warnings.push({
        severity: "warning",
        service: service.name,
        message: `Service "${service.name}" has ${service.replicas} replicas and a volume; consider a StatefulSet instead of Deployment + RWO PVC.`,
      });
    }

    for (const directive of service.unsupported) {
      warnings.push({
        severity: "warning",
        service: service.name,
        directive,
        message: `"${directive}" is not translated to Kubernetes and was dropped.`,
      });
    }
  }

  if (/\bdepends_on\b/.test(composeText)) {
    warnings.push({
      severity: "info",
      directive: "depends_on",
      message: `depends_on ordering has no Kubernetes equivalent. Pods start in parallel; make services resilient to startup order.`,
    });
  }

  return { manifests, warnings, catalogHints: catalogHints(model.services) };
}

export function combineManifests(docs: ManifestDoc[]): string {
  return docs.map((d) => d.yaml.trimEnd()).join("\n---\n") + "\n";
}
