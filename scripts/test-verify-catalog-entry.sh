#!/usr/bin/env bash
# Integration tests for verify-catalog-entry.sh. Network-dependent (hits real
# Helm repos and container registries) — this harness verifies against live
# tooling by design, so the tests do too. Run: scripts/test-verify-catalog-entry.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/verify-catalog-entry.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }

# expect_exit <expected-code> <desc> -- <command...>
expect_exit() {
  local want="$1"; local desc="$2"; shift 3
  "$@" >/dev/null 2>&1; local got=$?
  if [ "$got" -eq "$want" ]; then ok "$desc (exit $got)"; else bad "$desc (want $want, got $got)"; fi
}

echo "== helm-chart =="
expect_exit 0 "existing chart (harbor/harbor) passes" -- \
  "$V" helm-chart --repo-name harbor --repo-url https://helm.goharbor.io --chart harbor
expect_exit 1 "nonexistent chart fails" -- \
  "$V" helm-chart --repo-name harbor --repo-url https://helm.goharbor.io --chart no-such-chart-xyz

echo "== image =="
expect_exit 0 "existing image (minio/minio) passes" -- \
  "$V" image minio/minio
expect_exit 1 "nonexistent image fails" -- \
  "$V" image example.invalid/nope:doesnotexist
# Captured entrypoint is surfaced for the skill's lint judgment.
if "$V" image minio/minio 2>/dev/null | grep -q "docker-entrypoint.sh"; then
  ok "image prints captured Entrypoint"
else
  bad "image should print captured Entrypoint"
fi

echo "== manifest-validate (shape; client dry-run, no cluster needed) =="
cat > "$TMP/good.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo
data:
  k: v
YAML
cat > "$TMP/bad.yaml" <<'YAML'
metadata:
  name: demo
data:
  k: v
YAML
expect_exit 0 "well-formed manifest passes shape" -- "$V" manifest-validate --file "$TMP/good.yaml" --shape-only
expect_exit 1 "manifest missing kind fails shape"  -- "$V" manifest-validate --file "$TMP/bad.yaml" --shape-only

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
