/**
 * Node-watcher deployed alongside the descheduler when "Rebalance when a node
 * comes online" is enabled. A tiny kubectl pod holds a real `kubectl get nodes
 * --watch-only` stream and, on a node's Ready condition flipping to True, creates
 * a Job from the descheduler CronJob (debounced). `{{namespace}}` = the install
 * namespace; `{{cronjob}}` = the descheduler release/CronJob name.
 */
export const DESCHEDULER_NODE_WATCHER_MANIFEST = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: rigel-descheduler-node-watcher
  namespace: {{namespace}}
  labels:
    app.kubernetes.io/managed-by: rigel
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: rigel-descheduler-node-watcher
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: rigel-descheduler-node-watcher
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: rigel-descheduler-node-watcher
subjects:
  - kind: ServiceAccount
    name: rigel-descheduler-node-watcher
    namespace: {{namespace}}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: rigel-descheduler-node-watcher
  namespace: {{namespace}}
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create"]
  - apiGroups: ["batch"]
    resources: ["cronjobs"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: rigel-descheduler-node-watcher
  namespace: {{namespace}}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: rigel-descheduler-node-watcher
subjects:
  - kind: ServiceAccount
    name: rigel-descheduler-node-watcher
    namespace: {{namespace}}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: rigel-descheduler-node-watcher
  namespace: {{namespace}}
data:
  watch.sh: |
    #!/bin/sh
    # Stream node changes (server push, not polling); on a node's Ready condition
    # flipping to True, kick a descheduler run. Debounced; --watch-only skips the
    # initial node list so we don't fire on startup; outer loop reconnects.
    set -u
    STATE=/state
    COOLDOWN=60
    while true; do
      last=0
      kubectl get nodes --watch-only \\
        -o "jsonpath={.metadata.name} {range .status.conditions[?(@.type=='Ready')]}{.status}{end}{'\\n'}" 2>/dev/null |
      while read -r name ready; do
        [ -n "$name" ] || continue
        prev=$(cat "$STATE/$name" 2>/dev/null || echo "")
        printf '%s' "$ready" > "$STATE/$name"
        if [ "$ready" = "True" ] && [ "$prev" != "True" ]; then
          now=$(date +%s)
          [ $((now - last)) -ge $COOLDOWN ] || continue
          last=$now
          kubectl -n {{namespace}} create job --from=cronjob/{{cronjob}} "descheduler-nodejoin-$now" >/dev/null 2>&1 || true
        fi
      done
      sleep 2
    done
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rigel-descheduler-node-watcher
  namespace: {{namespace}}
  labels:
    app.kubernetes.io/managed-by: rigel
spec:
  replicas: 1
  selector:
    matchLabels:
      app: rigel-descheduler-node-watcher
  template:
    metadata:
      labels:
        app: rigel-descheduler-node-watcher
    spec:
      serviceAccountName: rigel-descheduler-node-watcher
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
      containers:
        - name: watcher
          image: bitnami/kubectl:latest
          command: ["/bin/sh", "/scripts/watch.sh"]
          resources:
            requests:
              cpu: "10m"
              memory: "32Mi"
            limits:
              memory: "64Mi"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: script
              mountPath: /scripts
            - name: state
              mountPath: /state
      volumes:
        - name: script
          configMap:
            name: rigel-descheduler-node-watcher
        - name: state
          emptyDir: {}
`;
