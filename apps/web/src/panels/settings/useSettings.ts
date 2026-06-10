// Derived Settings state — Signal bridge status + self-host defaults
// (docs/parity/settings.md). All bridge/recipient/status logic lives in the
// shared @helmsman/k8s port so it stays byte-identical with the Swift source.

import { useEffect, useMemo } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  deriveSignalBridgeStatus,
  hasSavedNumber as deriveHasSavedNumber,
  signalNumber as deriveSignalNumber,
  signalRecipients as deriveRecipients,
  signalInbound as deriveInbound,
  type SignalBridgeStatus,
} from "@helmsman/k8s";

interface Meta {
  name: string;
  namespace?: string;
}
interface ConfigMapLike {
  metadata: Meta;
  data?: Record<string, string>;
}
interface DeploymentLike {
  metadata: Meta;
  status?: { readyReplicas?: number };
}

// --- Self-host defaults (per-context localStorage) -------------------------

export interface SelfHostDefaults {
  clusterIssuer: string;
  ingressDomain: string;
  imagePullSecret: string;
  redirectMiddleware: string;
  edgeIP: string;
}

export const EMPTY_SELF_HOST_DEFAULTS: SelfHostDefaults = {
  clusterIssuer: "",
  ingressDomain: "",
  imagePullSecret: "",
  redirectMiddleware: "",
  edgeIP: "",
};

/** localStorage key for the active kubectl context (spec §3.1). */
export function selfHostKey(context: string): string {
  return `helmsman_selfhost_defaults_${context}`;
}

/** Read self-host defaults for `context`, falling back to all-empty. */
export function loadSelfHostDefaults(context: string): SelfHostDefaults {
  try {
    const raw = localStorage.getItem(selfHostKey(context));
    if (!raw) return EMPTY_SELF_HOST_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SelfHostDefaults>;
    return { ...EMPTY_SELF_HOST_DEFAULTS, ...parsed };
  } catch {
    return EMPTY_SELF_HOST_DEFAULTS;
  }
}

/** Trim every field, JSON-serialize, and persist under the context key. */
export function saveSelfHostDefaults(context: string, defaults: SelfHostDefaults): void {
  const trimmed: SelfHostDefaults = {
    clusterIssuer: defaults.clusterIssuer.trim(),
    ingressDomain: defaults.ingressDomain.trim(),
    imagePullSecret: defaults.imagePullSecret.trim(),
    redirectMiddleware: defaults.redirectMiddleware.trim(),
    edgeIP: defaults.edgeIP.trim(),
  };
  localStorage.setItem(selfHostKey(context), JSON.stringify(trimmed));
}

// --- Derived bridge state --------------------------------------------------

export interface SettingsDerived {
  /** Namespace the bridge lives in (assistant's ns, or default). */
  namespace: string;
  status: SignalBridgeStatus;
  /** Linked sender number (empty when unlinked). */
  signalNumber: string;
  /** Saved comma-separated recipients string. */
  recipients: string;
  /** Two-way inbound flag. */
  inbound: boolean;
  hasSavedNumber: boolean;
}

/**
 * Subscribe to the deployments + configmaps cluster-wide watches and derive the
 * Signal bridge state. `applying` is the local "kubectl apply in flight" flag
 * owned by the panel. The bridge namespace follows the assistant install (or
 * "default"), found by locating the helmsman-assistant Deployment.
 */
export function useSettings(applying: boolean): SettingsDerived {
  const resources = useCluster((s) => s.resources);

  useEffect(() => {
    const kinds = ["deployments", "configmaps"];
    for (const k of kinds) subscribe(k, "*");
    return () => {
      for (const k of kinds) unsubscribe(k, "*");
    };
  }, []);

  const deployments = useMemo(
    () => Object.values((resources["deployments"] ?? {}) as Record<string, DeploymentLike>),
    [resources],
  );
  const configMaps = useMemo(
    () => Object.values((resources["configmaps"] ?? {}) as Record<string, ConfigMapLike>),
    [resources],
  );

  return useMemo<SettingsDerived>(() => {
    // The bridge shares the assistant's namespace; default when not installed.
    const agent = deployments.find((d) => d.metadata.name === "helmsman-assistant");
    const namespace = agent?.metadata.namespace ?? "default";

    const config =
      configMaps.find(
        (c) =>
          c.metadata.name === "assistant-config" &&
          (c.metadata.namespace ?? "default") === namespace,
      )?.data ?? {};

    const savedNumber = deriveHasSavedNumber(config);

    return {
      namespace,
      status: deriveSignalBridgeStatus(deployments, namespace, savedNumber, applying),
      signalNumber: deriveSignalNumber(config),
      recipients: deriveRecipients(config),
      inbound: deriveInbound(config),
      hasSavedNumber: savedNumber,
    };
  }, [deployments, configMaps, applying]);
}
