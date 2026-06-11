#!/bin/sh
# Helmsman web entrypoint.
#
# The server shells out to the `kubectl` BINARY, which — unlike client-go — does
# NOT automatically use a pod's ServiceAccount. So when we're running in-cluster
# with no kubeconfig provided, synthesize one from the mounted SA credentials.
#
# Order of precedence (matches apps/server/src/kubeconfig.ts):
#   1. An explicit $KUBECONFIG (e.g. a mounted file — the local `docker compose`
#      path sets KUBECONFIG=/kube/config) → use it, do nothing here.
#   2. $HOME/.kube/config if present → kubectl uses it by default.
#   3. In-cluster ServiceAccount token → generate a kubeconfig pointing at it.
set -e

SA=/var/run/secrets/kubernetes.io/serviceaccount

if [ -z "${KUBECONFIG:-}" ] && [ ! -f "${HOME:-/root}/.kube/config" ] && [ -f "$SA/token" ]; then
  KUBECONFIG=/tmp/in-cluster-kubeconfig
  NS="$(cat "$SA/namespace" 2>/dev/null || echo default)"
  cat > "$KUBECONFIG" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: in-cluster
  cluster:
    certificate-authority: $SA/ca.crt
    server: https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}
contexts:
- name: in-cluster
  context:
    cluster: in-cluster
    user: in-cluster
    namespace: $NS
current-context: in-cluster
users:
- name: in-cluster
  user:
    tokenFile: $SA/token
EOF
  export KUBECONFIG
  echo "helmsman: running in-cluster — generated kubeconfig at $KUBECONFIG (sa namespace=$NS)"
fi

exec "$@"
