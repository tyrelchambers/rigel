// kubectl wrappers, output parsing, and resource types are ported here
// from Sources/Helmsman/Cluster/ via the parity orchestrator.

export * from "./alerts";

export { openapiV2ToYamlSchema, gvkApiVersion } from "./openapiSchema";

export {
  type GitSource,
  type GitDeployment,
  type ResolvedTarget,
  type GithubRepo,
  type RepoEntry,
  resolveTarget,
  findByDeployment,
  upsertDeployment,
  GIT_SOURCES_CONFIGMAP,
  GITHUB_SECRET,
  SOURCE_REPO_ANNOTATION,
  SOURCE_PATH_ANNOTATION,
  provenanceAnnotations,
  fixBranchName,
  safeRepoFilePath,
  sanitizeSourceName,
  normalizeManifestPath,
  parseRepoSlug,
  buildAuthedCloneURL,
  redactURL,
  parseGitSources,
  gitSourcesConfigMapJSON,
  githubSecretJSON,
  parseGithubRepos,
  parseRepoContents,
} from "./gitSources";

export {
  type MetricsInstallBackend,
  type InstalledBackend,
  METRICS_SERVICE_NAME,
  metricsBackendPort,
  metricsBackendTitle,
  resultingBackend,
  namespaceValid,
  renderMetricsInstallManifest,
} from "./metricsInstall";

export {
  type SuggestedAction,
  type SuggestedQuestion,
  type QuestionField,
  ACTION_KINDS,
  extractActionBlocks,
  extractAlertBlocks,
  extractQuestionBlocks,
  stripActionBlocks,
  parseSuggestedActions,
  isDestructiveAction,
  buildQuestionAnswer,
} from "./actionBlocks";

export {
  type ParsedLogLine,
  POD_COLORS,
  fnv1a32,
  fnv1aColorIndex,
  deploymentColorIndex,
  parseLogLine,
  isProbeLine,
  isErrorLine,
} from "./logs";

export {
  type ResourceKind,
  type RawResource,
  type DiscoveredResource,
  DISCOVERY_KINDS,
  MIN_CORE_LEN,
  canonicalKind,
  kubectlDeleteKind,
  defaultSelected,
  isProtectedNamespace,
  blockedNamespaceReason,
  isSharedInfraWorkload,
  core,
  isRelated,
  helmReleaseFromSecretName,
  detectHelmRelease,
  filterDiscovered,
  discoveryArgs,
  fallbackDiscoveryArgs,
  deleteArgs,
  helmUninstallArgs,
} from "./purge";

export {
  type AssistantInstallConfig,
  type TokenExpiryLevel,
  type TokenExpiryStatus,
  type AssistantAgentStatus,
  type AssistantAuditEntry,
  type AssistantQueuedSuggestion,
  type AssistantClusterState,
  type AssistantLiveIssue,
  DEFAULT_INSTALL_CONFIG,
  SECRET_NAME,
  ISSUED_AT_ANNOTATION,
  TOKEN_LIFETIME_DAYS,
  TOKEN_WARN_WITHIN_DAYS,
  namespaceYAML,
  secretYAML,
  rbac,
  configMaps,
  deployment,
  manifestYAML,
  maskToken,
  tokenExpiryStatus,
  parseTokenExpiry,
  decodeClusterState,
  auditEntryId,
  queuedSuggestionId,
  isEnabled,
  autonomyMode,
  quietWindow,
  silencedSet,
  podErrorReason,
  computeLiveIssues,
  mergedConfigMapJSON,
  clearedReportConfigMapJSON,
} from "./assistant";

export {
  type SignalBridgeStatus,
  SIGNAL_BRIDGE_NAME,
  SIGNAL_BRIDGE_PORT,
  SIGNAL_DEVICE_NAME,
  signalBridgeManifest,
  deriveSignalBridgeStatus,
  signalStatusColor,
  signalStatusLabel,
  parseRecipients,
  signalApiUrl,
  signalNumber,
  signalRecipients,
  signalInbound,
  hasSavedNumber,
  signalConfigUpdates,
} from "./signal";

export {
  type RegistryCredential,
  type DockerConfigJsonAuth,
  type DockerConfigJsonData,
  type KubernetesSecret,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  DOCKERCONFIGJSON_TYPE,
  DOCKERCONFIGJSON_KEY,
  DOCKER_HUB_KEY,
  base64Encode,
  base64Decode,
  normalizeRegistryKey,
  buildDockerConfigJson,
  buildAuths,
  dockerconfigjsonToSecret,
  parseDockerConfigJson,
  extractRegistryFromSecret,
  displayRegistry,
  isValidDNS1123Subdomain,
} from "./dockerconfigjson";

export {
  type SecretTypeId,
  type SecretTypeInfo,
  type KVRow,
  type DockerCredsForm,
  CREATABLE_SECRET_TYPES,
  canonicalKeysFor,
  secretTypeId,
  encodeSecretValue,
  decodeSecretValue,
  decodedByteLength,
  validateConfigMapName,
  validateSecretName,
  canSubmitConfigMap,
  canSubmitSecret,
  emptyDockerCreds,
  encodeDockerConfigJson,
  parseDockerCredsForm,
  buildConfigMapYAML,
  buildSecretYAML,
  newRowId,
  blankRow,
  seedConfigMapRows,
  seedSecretRows,
  rowsToConfigMapData,
} from "./configmapSecretEditor";

export {
  type IngressLike,
  type IngressInput,
  type IngressRuleInput,
  type IngressPathInput,
  type IngressTLSInput,
  IMPLEMENTATION_SPECIFIC,
  blankPath,
  blankRule,
  blankTLS,
  ingressToInput,
  canSubmitIngress,
  buildIngressYAML,
} from "./ingressEditor";

/** Kubernetes ObjectMeta (subset used by the web panels). */
export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  creationTimestamp?: string; // ISO 8601
  labels?: Record<string, string>;
}

/** Container state (subset). */
export interface ContainerState {
  running?: { startedAt?: string };
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode?: number };
}

/** A single entry in `status.containerStatuses`. */
export interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: ContainerState;
}

/** A container in `spec.containers`. */
export interface Container {
  name: string;
  image?: string;
  ports?: Array<{ containerPort: number; name?: string }>;
}

/**
 * Pod — mirrors the Kubernetes Pod JSON schema and the Swift
 * `Pod` type in `Sources/Helmsman/Cluster/KubeTypes.swift`.
 */
export interface Pod {
  metadata: ObjectMeta;
  spec: {
    nodeName?: string;
    containers: Container[];
  };
  status?: {
    phase?: string; // "Running" | "Pending" | "Failed" | "Succeeded" | ...
    podIP?: string;
    containerStatuses?: ContainerStatus[];
  };
}

/** The resource an event refers to (`involvedObject`). All fields optional. */
export interface InvolvedObject {
  kind: string | null;
  name: string | null;
  namespace: string | null;
  uid: string | null;
}

/**
 * K8sEvent — mirrors the Kubernetes Event JSON schema and the Swift
 * `K8sEvent` type in `Sources/Helmsman/Cluster/KubeTypes.swift`. Events are
 * read-only and ephemeral (~1h TTL). See `docs/parity/events.md`.
 *
 * NOTE: `metadata` here is loosened (`type` and timestamps may be absent on the
 * watch stream), so it does not reuse `ObjectMeta` (which requires `uid`). The
 * client keys events by `metadata.uid`.
 */
export interface K8sEvent {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601
  };
  type: string | null; // "Normal" | "Warning" | null
  reason: string | null;
  message: string | null;
  count: number | null;
  firstTimestamp: string | null; // ISO 8601
  lastTimestamp: string | null; // ISO 8601
  involvedObject: InvolvedObject | null;
}

/**
 * Secret — mirrors the Kubernetes Secret JSON schema and the Swift
 * `Secret` type in `Sources/Helmsman/Cluster/Secret.swift`. Secrets are
 * namespace-scoped. All values in `data` are base64-encoded as returned by
 * `kubectl get -o json`. See `docs/parity/secrets.md`.
 */
export interface Secret {
  metadata: ObjectMeta;
  /** e.g. "Opaque", "kubernetes.io/dockerconfigjson", "kubernetes.io/tls". */
  type?: string;
  /** Base64-encoded key/value pairs. */
  data?: Record<string, string>;
}

/**
 * ConfigMap — mirrors the Kubernetes ConfigMap JSON schema and the Swift
 * `ConfigMap` type in `Sources/Helmsman/Cluster/ConfigMap.swift`. Namespace-
 * scoped. `data` holds plaintext UTF-8 values; `binaryData` holds base64-encoded
 * values (read-only in the editor, carried through unchanged on edit).
 * See `docs/parity/configmaps.md`.
 */
export interface ConfigMap {
  metadata: ObjectMeta;
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
}
