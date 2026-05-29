import Foundation

/// Knobs the installer bakes into the agent's Deployment + config. Mirrors the
/// committed reference manifests in `agent/manifests/`.
struct AssistantInstallConfig {
    var image: String
    /// Comma-separated namespaces to scope to; empty = all.
    var namespaces: String
    /// Name of an image-pull Secret for a private registry (e.g. GHCR). Empty =
    /// none (public image). Referenced by the Deployment; the wizard can also
    /// create it from a registry username + token.
    var imagePullSecretName: String = ""
    var workerModel: String
    var supervisorModel: String
    var spendCapUsd: Int
    var pollIntervalMs: Int
    var maxPerResourcePerHour: Int
    var maxPerNight: Int
    var maxAttemptsPerIncident: Int
    var confirmPolls: Int

    static let `default` = AssistantInstallConfig(
        image: "ghcr.io/tyrelchambers/helmsman-assistant:latest",
        namespaces: "",
        workerModel: "claude-sonnet-4-6",
        supervisorModel: "claude-opus-4-8",
        spendCapUsd: 50,
        pollIntervalMs: 30000,
        maxPerResourcePerHour: 3,
        maxPerNight: 20,
        maxAttemptsPerIncident: 3,
        confirmPolls: 2
    )
}

/// Builds the exact manifests Helmsman applies during guided install. These are
/// the Swift source of truth that mirrors `agent/manifests/`. The Secret (which
/// carries the OAuth token) is generated separately and never shown in the
/// preview.
///
/// RBAC cage invariant: nothing here grants access to `secrets`.
enum AssistantInstaller {
    static let namespace = "default"
    static let secretName = "assistant-claude-token"

    static func manifestYAML(_ c: AssistantInstallConfig) -> String {
        [rbac, configMaps, deployment(c)].joined(separator: "\n---\n")
    }

    static func secretYAML(token: String, issuedAt: String = "") -> String {
        """
        apiVersion: v1
        kind: Secret
        metadata:
          name: \(secretName)
          namespace: \(namespace)
          labels:
            app.kubernetes.io/managed-by: helmsman-assistant
          annotations:
            \(TokenExpiry.issuedAtAnnotation): "\(issuedAt)"
        type: Opaque
        stringData:
          token: "\(escape(token))"
        """
    }

    /// A `kubernetes.io/dockerconfigjson` pull Secret for a private registry.
    /// Built separately and applied before the Deployment; never shown in preview.
    static func dockerConfigSecretYAML(name: String, registry: String, username: String, token: String) -> String {
        let auth = Data("\(username):\(token)".utf8).base64EncodedString()
        let dockerConfig = "{\"auths\":{\"\(registry)\":{\"username\":\"\(escape(username))\",\"password\":\"\(escape(token))\",\"auth\":\"\(auth)\"}}}"
        return """
        apiVersion: v1
        kind: Secret
        metadata:
          name: \(name)
          namespace: \(namespace)
          labels:
            app.kubernetes.io/managed-by: helmsman-assistant
        type: kubernetes.io/dockerconfigjson
        stringData:
          .dockerconfigjson: '\(dockerConfig)'
        """
    }

    // MARK: - Pieces

    private static let rbac = """
    apiVersion: v1
    kind: ServiceAccount
    metadata:
      name: helmsman-assistant
      namespace: default
      labels:
        app.kubernetes.io/managed-by: helmsman-assistant
    ---
    apiVersion: rbac.authorization.k8s.io/v1
    kind: ClusterRole
    metadata:
      name: helmsman-assistant
      labels:
        app.kubernetes.io/managed-by: helmsman-assistant
    rules:
      - apiGroups: [""]
        resources: [pods, pods/log, nodes, events, namespaces, services, endpoints, persistentvolumeclaims, persistentvolumes, replicationcontrollers, configmaps]
        verbs: [get, list, watch]
      - apiGroups: ["apps"]
        resources: [deployments, replicasets, statefulsets, daemonsets]
        verbs: [get, list, watch]
      - apiGroups: ["batch"]
        resources: [jobs, cronjobs]
        verbs: [get, list, watch]
      - apiGroups: ["metrics.k8s.io"]
        resources: [pods, nodes]
        verbs: [get, list]
      - apiGroups: ["apps"]
        resources: [deployments]
        verbs: [patch, update]
      - apiGroups: ["apps"]
        resources: [deployments/scale]
        verbs: [patch, update]
      - apiGroups: [""]
        resources: [pods]
        verbs: [delete]
      - apiGroups: [""]
        resources: [nodes]
        verbs: [patch]
    ---
    apiVersion: rbac.authorization.k8s.io/v1
    kind: ClusterRoleBinding
    metadata:
      name: helmsman-assistant
      labels:
        app.kubernetes.io/managed-by: helmsman-assistant
    roleRef:
      apiGroup: rbac.authorization.k8s.io
      kind: ClusterRole
      name: helmsman-assistant
    subjects:
      - kind: ServiceAccount
        name: helmsman-assistant
        namespace: default
    ---
    apiVersion: rbac.authorization.k8s.io/v1
    kind: Role
    metadata:
      name: helmsman-assistant-state
      namespace: default
      labels:
        app.kubernetes.io/managed-by: helmsman-assistant
    rules:
      - apiGroups: [""]
        resources: [configmaps]
        resourceNames: [assistant-config, assistant-state, assistant-backups]
        verbs: [get, update, patch]
    ---
    apiVersion: rbac.authorization.k8s.io/v1
    kind: RoleBinding
    metadata:
      name: helmsman-assistant-state
      namespace: default
      labels:
        app.kubernetes.io/managed-by: helmsman-assistant
    roleRef:
      apiGroup: rbac.authorization.k8s.io
      kind: Role
      name: helmsman-assistant-state
    subjects:
      - kind: ServiceAccount
        name: helmsman-assistant
        namespace: default
    """

    private static let configMaps = """
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: assistant-config
      namespace: default
      labels:
        app.kubernetes.io/managed-by: helmsman-assistant
    data:
      enabled: "true"
    ---
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: assistant-state
      namespace: default
      labels:
        app.kubernetes.io/managed-by: helmsman-assistant
    data: {}
    ---
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: assistant-backups
      namespace: default
      labels:
        app.kubernetes.io/managed-by: helmsman-assistant
    data: {}
    """

    private static func deployment(_ c: AssistantInstallConfig) -> String {
        let pullSecrets = c.imagePullSecretName.isEmpty
            ? ""
            : "\n              imagePullSecrets:\n                - name: \(c.imagePullSecretName)"
        return """
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: helmsman-assistant
          namespace: default
          labels:
            app.kubernetes.io/name: helmsman-assistant
            app.kubernetes.io/managed-by: helmsman-assistant
        spec:
          replicas: 1
          strategy:
            type: Recreate
          selector:
            matchLabels:
              app.kubernetes.io/name: helmsman-assistant
          template:
            metadata:
              labels:
                app.kubernetes.io/name: helmsman-assistant
            spec:
              serviceAccountName: helmsman-assistant\(pullSecrets)
              securityContext:
                runAsNonRoot: true
                seccompProfile:
                  type: RuntimeDefault
              containers:
                - name: agent
                  image: \(c.image)
                  imagePullPolicy: IfNotPresent
                  env:
                    - name: CLAUDE_CODE_OAUTH_TOKEN
                      valueFrom:
                        secretKeyRef:
                          name: \(secretName)
                          key: token
                    - name: WORKER_MODEL
                      value: "\(c.workerModel)"
                    - name: SUPERVISOR_MODEL
                      value: "\(c.supervisorModel)"
                    - name: POLL_INTERVAL_MS
                      value: "\(c.pollIntervalMs)"
                    - name: SPEND_CAP_USD
                      value: "\(c.spendCapUsd)"
                    - name: MAX_PER_RESOURCE_PER_HOUR
                      value: "\(c.maxPerResourcePerHour)"
                    - name: MAX_PER_NIGHT
                      value: "\(c.maxPerNight)"
                    - name: MAX_ATTEMPTS_PER_INCIDENT
                      value: "\(c.maxAttemptsPerIncident)"
                    - name: CONFIRM_POLLS
                      value: "\(c.confirmPolls)"
                    - name: NAMESPACES
                      value: "\(c.namespaces)"
                  securityContext:
                    allowPrivilegeEscalation: false
                    capabilities:
                      drop: ["ALL"]
                  resources:
                    requests:
                      cpu: 50m
                      memory: 128Mi
                    limits:
                      cpu: "1"
                      memory: 512Mi
        """
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }
}
