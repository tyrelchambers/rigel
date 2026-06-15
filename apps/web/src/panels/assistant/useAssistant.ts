// Derived Assistant state, read from the live cluster store (the web analogue
// of Swift's `AssistantViewModel`). All derivation logic is the shared port in
// `@helmsman/k8s` so it stays byte-identical with the Swift source of truth.

import { useEffect, useMemo } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  decodeClusterState,
  isEnabled as deriveEnabled,
  autonomyMode as deriveMode,
  quietWindow as deriveWindow,
  silencedSet as deriveSilenced,
  computeLiveIssues,
  parseTokenExpiry,
  parseAlertRules,
  ISSUED_AT_ANNOTATION,
  SECRET_NAME,
  type AssistantClusterState,
  type AssistantLiveIssue,
  type TokenExpiryStatus,
  type AlertRule,
} from "@helmsman/k8s";

// Minimal shapes for the watched resources (we only read what we render).
interface Meta {
  name: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
interface ConfigMapLike {
  metadata: Meta;
  data?: Record<string, string>;
}
interface SecretLike {
  metadata: Meta;
}
interface DeploymentLike {
  metadata: Meta;
  spec?: { replicas?: number };
  status?: { replicas?: number; readyReplicas?: number };
}
interface PodLike {
  metadata: Meta;
  status?: {
    phase?: string;
    containerStatuses?: Array<{ restartCount?: number; state?: { waiting?: { reason?: string } } }>;
  };
}
interface NamespaceLike {
  metadata: Meta;
}

const POD_LABEL = "app.kubernetes.io/name";

export interface AssistantDerived {
  isInstalled: boolean;
  installedNamespace: string | null;
  /** Namespace to read the agent's own resources from (install ns fallback). */
  stateNamespace: string;
  enabled: boolean;
  autonomyMode: string;
  quietWindow: string;
  webhookURL: string;
  silenced: string[];
  clusterState: AssistantClusterState | null;
  agentPod: PodLike | null;
  agentPodRestarts: number;
  agentPodReason: string | null;
  liveIssues: AssistantLiveIssue[];
  tokenExpiry: TokenExpiryStatus | null;
  allNamespaceNames: string[];
  /** Stored backup YAML for a revert, keyed by backupRef. */
  backupYAML: (ref: string) => string | undefined;
  /** Parsed alert rules from the assistant-config ConfigMap. */
  alertRules: AlertRule[];
}

/**
 * Subscribe to the assistant-relevant watches and derive panel state. Mirrors
 * the Swift ClusterCache reads. `installNamespaceHint` is the form's chosen
 * install namespace, used only before the agent exists (so state reads still
 * resolve to a namespace).
 */
export function useAssistant(installNamespaceHint: string): AssistantDerived {
  const resources = useCluster((s) => s.resources);

  // The panel needs cluster-wide visibility (the agent can live anywhere, and
  // live issues span every namespace). These watches are keyed by name in the
  // shared store; the agent's own objects are uniquely named.
  useEffect(() => {
    const kinds = ["deployments", "pods", "configmaps", "secrets", "namespaces"];
    for (const k of kinds) subscribe(k, "*");
    return () => {
      for (const k of kinds) unsubscribe(k, "*");
    };
  }, []);

  const deployments = useMemo(
    () => Object.values((resources["deployments"] ?? {}) as Record<string, DeploymentLike>),
    [resources],
  );
  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, PodLike>),
    [resources],
  );
  const configMaps = useMemo(
    () => Object.values((resources["configmaps"] ?? {}) as Record<string, ConfigMapLike>),
    [resources],
  );
  const secrets = useMemo(
    () => Object.values((resources["secrets"] ?? {}) as Record<string, SecretLike>),
    [resources],
  );
  const namespaces = useMemo(
    () => Object.values((resources["namespaces"] ?? {}) as Record<string, NamespaceLike>),
    [resources],
  );

  return useMemo<AssistantDerived>(() => {
    const agentDeployment = deployments.find((d) => d.metadata.name === "helmsman-assistant") ?? null;
    const isInstalled = agentDeployment != null;
    const installedNamespace = agentDeployment ? agentDeployment.metadata.namespace ?? "default" : null;
    const stateNamespace = installedNamespace ?? installNamespaceHint;

    const configMap = (name: string): ConfigMapLike | undefined =>
      configMaps.find(
        (c) => c.metadata.name === name && (c.metadata.namespace ?? "default") === stateNamespace,
      );

    const configData = configMap("assistant-config")?.data ?? {};
    const stateRaw = configMap("assistant-state")?.data?.["state.json"];
    const clusterState = decodeClusterState(stateRaw);

    const agentPod =
      pods.find(
        (p) =>
          p.metadata.labels?.[POD_LABEL] === "helmsman-assistant" &&
          (p.metadata.namespace ?? "default") === stateNamespace,
      ) ?? null;
    const agentPodRestarts =
      agentPod?.status?.containerStatuses?.reduce((sum, c) => sum + (c.restartCount ?? 0), 0) ?? 0;
    const agentPodReason = agentPod
      ? agentPod.status?.phase === "Failed"
        ? "Failed"
        : (agentPod.status?.containerStatuses ?? [])
            .map((c) => c.state?.waiting?.reason)
            .find((r) => r && ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "RunContainerError", "InvalidImageName"].includes(r)) ?? null
      : null;

    const secret = secrets.find(
      (s) => s.metadata.name === SECRET_NAME && (s.metadata.namespace ?? "default") === stateNamespace,
    );
    const tokenExpiry = parseTokenExpiry(
      secret?.metadata.annotations?.[ISSUED_AT_ANNOTATION],
      new Date(),
    );

    return {
      isInstalled,
      installedNamespace,
      stateNamespace,
      enabled: deriveEnabled(configData),
      autonomyMode: deriveMode(configData),
      quietWindow: deriveWindow(configData),
      webhookURL: configData["webhookUrl"] ?? "",
      silenced: [...deriveSilenced(configData)].sort(),
      clusterState,
      agentPod,
      agentPodRestarts,
      agentPodReason,
      liveIssues: computeLiveIssues(pods, deployments),
      tokenExpiry,
      allNamespaceNames: namespaces.map((n) => n.metadata.name).sort(),
      backupYAML: (ref) => configMap("assistant-backups")?.data?.[ref],
      alertRules: parseAlertRules(configData["alertRules"]),
    };
  }, [deployments, pods, configMaps, secrets, namespaces, installNamespaceHint]);
}
