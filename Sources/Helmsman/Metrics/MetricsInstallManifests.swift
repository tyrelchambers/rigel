import Foundation

/// Renders the install manifest for a metrics backend. Both backends scrape
/// cAdvisor through the API-server proxy (works without direct node access) and
/// expose a Prometheus-compatible query API on a Service named `helmsman-metrics`.
///
/// Image tags are pinned to known-good releases; bump as desired.
enum MetricsInstallManifests {
    enum Backend: String, CaseIterable, Identifiable {
        case victoriaMetrics
        case prometheus
        var id: String { rawValue }
        var title: String { self == .victoriaMetrics ? "VictoriaMetrics" : "Prometheus" }
        /// Query API port of the installed Service.
        var port: Int { self == .victoriaMetrics ? 8428 : 9090 }
    }

    static let serviceName = "helmsman-metrics"
    private static let vmImage = "victoriametrics/victoria-metrics:v1.93.0"
    private static let promImage = "prom/prometheus:v2.53.0"

    /// Final multi-doc YAML for `kubectl apply -f -`.
    static func manifest(backend: Backend, namespace: String, persistent: Bool, sizeGiB: Int) -> String {
        switch backend {
        case .victoriaMetrics: return victoriaMetrics(namespace: namespace, persistent: persistent, sizeGiB: sizeGiB)
        case .prometheus:      return prometheus(namespace: namespace, persistent: persistent, sizeGiB: sizeGiB)
        }
    }

    /// The backend config that points at the just-installed Service.
    static func resultingBackend(_ backend: Backend, namespace: String) -> MetricsBackendConfig {
        .prometheus(namespace: namespace, service: serviceName, port: backend.port)
    }

    // MARK: - Shared bits

    /// cAdvisor scrape job via the API-server node proxy (Prometheus scrape-config
    /// format, used by both Prometheus and VictoriaMetrics' -promscrape.config).
    private static func scrapeConfig() -> String {
        """
        global:
          scrape_interval: 60s
        scrape_configs:
          - job_name: kubernetes-cadvisor
            scheme: https
            tls_config:
              ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
              insecure_skip_verify: true
            bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
            kubernetes_sd_configs:
              - role: node
            relabel_configs:
              - action: labelmap
                regex: __meta_kubernetes_node_label_(.+)
              - target_label: __address__
                replacement: kubernetes.default.svc:443
              - source_labels: [__meta_kubernetes_node_name]
                regex: (.+)
                target_label: __metrics_path__
                replacement: /api/v1/nodes/${1}/proxy/metrics/cadvisor
        """
    }

    private static func rbac(namespace: String) -> String {
        """
        apiVersion: v1
        kind: ServiceAccount
        metadata:
          name: \(serviceName)
          namespace: \(namespace)
        ---
        apiVersion: rbac.authorization.k8s.io/v1
        kind: ClusterRole
        metadata:
          name: \(serviceName)-\(namespace)
        rules:
          - apiGroups: [""]
            resources: [nodes, nodes/proxy, nodes/metrics, services, endpoints, pods]
            verbs: [get, list, watch]
          - nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
            verbs: [get]
        ---
        apiVersion: rbac.authorization.k8s.io/v1
        kind: ClusterRoleBinding
        metadata:
          name: \(serviceName)-\(namespace)
        roleRef:
          apiGroup: rbac.authorization.k8s.io
          kind: ClusterRole
          name: \(serviceName)-\(namespace)
        subjects:
          - kind: ServiceAccount
            name: \(serviceName)
            namespace: \(namespace)
        """
    }

    /// `data:` volume — a PVC reference or an emptyDir.
    private static func dataVolume(persistent: Bool) -> String {
        persistent
            ? "        - name: data\n          persistentVolumeClaim:\n            claimName: \(serviceName)"
            : "        - name: data\n          emptyDir: {}"
    }

    private static func pvc(namespace: String, sizeGiB: Int) -> String {
        """
        ---
        apiVersion: v1
        kind: PersistentVolumeClaim
        metadata:
          name: \(serviceName)
          namespace: \(namespace)
        spec:
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: \(sizeGiB)Gi
        """
    }

    private static func indented(_ text: String, by spaces: Int) -> String {
        let pad = String(repeating: " ", count: spaces)
        return text.split(separator: "\n", omittingEmptySubsequences: false).map { pad + $0 }.joined(separator: "\n")
    }

    // MARK: - VictoriaMetrics

    private static func victoriaMetrics(namespace: String, persistent: Bool, sizeGiB: Int) -> String {
        var docs = [
            "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: \(namespace)",
            rbac(namespace: namespace),
            """
            apiVersion: v1
            kind: ConfigMap
            metadata:
              name: \(serviceName)-scrape
              namespace: \(namespace)
            data:
              scrape.yml: |
            \(indented(scrapeConfig(), by: 4))
            """,
            """
            apiVersion: apps/v1
            kind: Deployment
            metadata:
              name: \(serviceName)
              namespace: \(namespace)
            spec:
              replicas: 1
              selector:
                matchLabels: { app: \(serviceName) }
              template:
                metadata:
                  labels: { app: \(serviceName) }
                spec:
                  serviceAccountName: \(serviceName)
                  containers:
                    - name: victoria-metrics
                      image: \(vmImage)
                      args:
                        - -storageDataPath=/data
                        - -retentionPeriod=1
                        - -promscrape.config=/config/scrape.yml
                        - -httpListenAddr=:8428
                      ports:
                        - containerPort: 8428
                      volumeMounts:
                        - { name: data, mountPath: /data }
                        - { name: config, mountPath: /config }
                  volumes:
            \(dataVolume(persistent: persistent))
                    - name: config
                      configMap: { name: \(serviceName)-scrape }
            """,
            """
            apiVersion: v1
            kind: Service
            metadata:
              name: \(serviceName)
              namespace: \(namespace)
            spec:
              selector: { app: \(serviceName) }
              ports:
                - { name: http, port: 8428, targetPort: 8428 }
            """,
        ]
        if persistent { docs.append(pvc(namespace: namespace, sizeGiB: sizeGiB)) }
        return docs.joined(separator: "\n---\n") + "\n"
    }

    // MARK: - Prometheus

    private static func prometheus(namespace: String, persistent: Bool, sizeGiB: Int) -> String {
        var docs = [
            "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: \(namespace)",
            rbac(namespace: namespace),
            """
            apiVersion: v1
            kind: ConfigMap
            metadata:
              name: \(serviceName)-config
              namespace: \(namespace)
            data:
              prometheus.yml: |
            \(indented(scrapeConfig(), by: 4))
            """,
            """
            apiVersion: apps/v1
            kind: Deployment
            metadata:
              name: \(serviceName)
              namespace: \(namespace)
            spec:
              replicas: 1
              selector:
                matchLabels: { app: \(serviceName) }
              template:
                metadata:
                  labels: { app: \(serviceName) }
                spec:
                  serviceAccountName: \(serviceName)
                  containers:
                    - name: prometheus
                      image: \(promImage)
                      args:
                        - --config.file=/config/prometheus.yml
                        - --storage.tsdb.path=/data
                        - --storage.tsdb.retention.time=30d
                        - --web.listen-address=:9090
                      ports:
                        - containerPort: 9090
                      volumeMounts:
                        - { name: data, mountPath: /data }
                        - { name: config, mountPath: /config }
                  volumes:
            \(dataVolume(persistent: persistent))
                    - name: config
                      configMap: { name: \(serviceName)-config }
            """,
            """
            apiVersion: v1
            kind: Service
            metadata:
              name: \(serviceName)
              namespace: \(namespace)
            spec:
              selector: { app: \(serviceName) }
              ports:
                - { name: http, port: 9090, targetPort: 9090 }
            """,
        ]
        if persistent { docs.append(pvc(namespace: namespace, sizeGiB: sizeGiB)) }
        return docs.joined(separator: "\n---\n") + "\n"
    }
}
