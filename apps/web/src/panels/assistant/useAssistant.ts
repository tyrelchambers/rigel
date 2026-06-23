// Derived Assistant state, read from the live cluster store (the web analogue
// of Swift's `AssistantViewModel`). All derivation logic is the shared port in
// `@rigel/k8s` so it stays byte-identical with the Swift source of truth.

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
} from "@rigel/k8s";
import type { AssistantRoleSelection, AssistantLimits } from "@/lib/api";
import { DEFAULT_WORKER, DEFAULT_SUPERVISOR } from "./agents/providerMeta";

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

export interface AssistantReady {
  /** deployments snapshot has arrived → can determine installed-or-not + which tabs to show. */
  deployments: boolean;
  /** configmaps snapshot has arrived → stats, alerts, audit, queue, autonomy, silenced. */
  state: boolean;
  /** pods snapshot has arrived → live-issues count. */
  pods: boolean;
  /** secrets snapshot has arrived → token expiry. */
  secrets: boolean;
}

export interface AssistantDerived {
  /** Granular per-resource readiness (replaces the old single `hydrated` flag). */
  ready: AssistantReady;
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
  /** Per-role provider/model/effort, parsed from assistant-config (defaults applied). */
  roles: { worker: AssistantRoleSelection; supervisor: AssistantRoleSelection };
  /** Operational limits parsed from assistant-config (absent keys omitted). */
  limits: AssistantLimits;
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
    const agentDeployment = deployments.find((d) => d.metadata.name === "rigel-assistant") ?? null;
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
          p.metadata.labels?.[POD_LABEL] === "rigel-assistant" &&
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
      // Readiness gates on ACTUAL DATA, not "a snapshot arrived". The server's
      // watchManager sends an empty snapshot first (cold cache) then streams
      // every object as an ADDED delta, so `!!resources[kind]` flips true while
      // the list is still empty — which is exactly what made the Installer flash
      // before real deployments (incl. rigel-assistant) had arrived. Gate on
      // non-empty data instead (and on the decoded assistant-state for stats).
      ready: {
        deployments: deployments.length > 0,
        state:       clusterState != null,
        pods:        pods.length > 0,
        secrets:     secrets.length > 0,
      },
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
      roles: parseRolesFromConfig(configData),
      limits: parseLimitsFromConfig(configData),
    };
  }, [deployments, pods, configMaps, secrets, namespaces, installNamespaceHint]);
}

/** Parse the per-role selections from the assistant-config data map, defaulting
 *  to the out-of-box Claude worker/supervisor when no role keys are present. */
export function parseRolesFromConfig(
  data: Record<string, string>,
): { worker: AssistantRoleSelection; supervisor: AssistantRoleSelection } {
  const role = (
    p: string | undefined,
    m: string | undefined,
    e: string | undefined,
    fallback: AssistantRoleSelection,
  ): AssistantRoleSelection => {
    if (!p && !m) return fallback;
    return {
      provider: p ?? fallback.provider,
      model: m ?? fallback.model,
      ...(e ? { effort: e } : {}),
    };
  };
  return {
    worker: role(data.workerProvider, data.workerModel, data.workerEffort, DEFAULT_WORKER),
    supervisor: role(
      data.supervisorProvider,
      data.supervisorModel,
      data.supervisorEffort,
      DEFAULT_SUPERVISOR,
    ),
  };
}

/** Parse the operational limits from the assistant-config data map (numbers
 *  coerced; namespaces split on commas/newlines; absent keys omitted). */
export function parseLimitsFromConfig(data: Record<string, string>): AssistantLimits {
  const num = (v: string | undefined): number | undefined =>
    v === undefined || v.trim() === "" ? undefined : Number(v);
  const limits: AssistantLimits = {};
  if (data.pollIntervalMs !== undefined) limits.pollIntervalMs = num(data.pollIntervalMs);
  if (data.maxPerResourcePerHour !== undefined) limits.maxPerResourcePerHour = num(data.maxPerResourcePerHour);
  if (data.maxPerNight !== undefined) limits.maxPerNight = num(data.maxPerNight);
  if (data.maxAttemptsPerIncident !== undefined) limits.maxAttemptsPerIncident = num(data.maxAttemptsPerIncident);
  if (data.confirmPolls !== undefined) limits.confirmPolls = num(data.confirmPolls);
  if (data.namespaces !== undefined) {
    limits.namespaces = data.namespaces.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  }
  return limits;
}
