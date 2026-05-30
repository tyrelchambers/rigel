import Foundation

/// Builds the manifests Helmsman applies to stand up the self-hosted Signal
/// bridge (bbernhard/signal-cli-rest-api). Swift source of truth mirroring
/// `agent/manifests/signal-cli-rest-api.yaml`; required because the bundled
/// .app can't read the repo file at runtime.
enum SignalBridgeManifests {
    static let serviceName = "signal-cli-rest"
    static let pvcName = "signal-cli-data"
    static let port = 8080
    private static let image = "bbernhard/signal-cli-rest-api:latest"

    /// In-cluster URL the agent uses to reach the bridge. Fully-qualified so it
    /// resolves regardless of which namespace the agent runs in.
    static func apiURL(namespace: String) -> String {
        "http://\(serviceName).\(namespace).svc.cluster.local:\(port)"
    }

    /// Final multi-doc YAML for `kubectl apply -f -`.
    static func manifest(namespace: String) -> String {
        [pvc(namespace: namespace), deployment(namespace: namespace), service(namespace: namespace)].joined(separator: "\n---\n") + "\n"
    }

    private static func pvc(namespace: String) -> String {
        """
        apiVersion: v1
        kind: PersistentVolumeClaim
        metadata:
          name: \(pvcName)
          namespace: \(namespace)
          labels:
            app.kubernetes.io/managed-by: helmsman-assistant
        spec:
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 1Gi
        """
    }

    private static func deployment(namespace: String) -> String {
        """
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: \(serviceName)
          namespace: \(namespace)
          labels:
            app.kubernetes.io/name: \(serviceName)
            app.kubernetes.io/managed-by: helmsman-assistant
        spec:
          replicas: 1
          strategy:
            type: Recreate
          selector:
            matchLabels:
              app.kubernetes.io/name: \(serviceName)
          template:
            metadata:
              labels:
                app.kubernetes.io/name: \(serviceName)
            spec:
              containers:
                - name: signal-cli-rest-api
                  image: \(image)
                  imagePullPolicy: IfNotPresent
                  env:
                    - name: MODE
                      value: native
                  ports:
                    - containerPort: \(port)
                  volumeMounts:
                    - name: data
                      mountPath: /home/.local/share/signal-cli
                  resources:
                    requests:
                      cpu: 25m
                      memory: 128Mi
                    limits:
                      memory: 512Mi
              volumes:
                - name: data
                  persistentVolumeClaim:
                    claimName: \(pvcName)
        """
    }

    private static func service(namespace: String) -> String {
        """
        apiVersion: v1
        kind: Service
        metadata:
          name: \(serviceName)
          namespace: \(namespace)
          labels:
            app.kubernetes.io/managed-by: helmsman-assistant
        spec:
          selector:
            app.kubernetes.io/name: \(serviceName)
          ports:
            - port: \(port)
              targetPort: \(port)
        """
    }
}
