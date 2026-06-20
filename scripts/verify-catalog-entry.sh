#!/usr/bin/env bash
#
# verify-catalog-entry.sh — deterministic verification harness for Rigel
# catalog entries. The "absolutely sure" core of the catalog-entry skill: it
# proves install correctness against LIVE tooling (helm/docker/kubectl) rather
# than trusting LLM research.
#
# It does NOT make judgment calls. It checks unambiguous facts and CAPTURES the
# image Entrypoint/Cmd; the skill applies the entrypoint-vs-`command` lint using
# that captured data (per the design — "flag, don't auto-rewrite").
#
# Subcommands (each independently runnable; nonzero exit on failure):
#   helm-chart      --repo-name N --repo-url U --chart C [--version V]
#   helm-render     --repo-name N --repo-url U --chart C [--version V] --values FILE [--namespace NS]
#   manifest-validate --file FILE [--namespace NS] [--shape-only]
#   image           IMAGE [IMAGE ...]
#
set -uo pipefail

pass() { printf '[PASS] %s — %s\n' "$1" "$2"; }
fail() { printf '[FAIL] %s — %s\n' "$1" "$2" >&2; }
info() { printf '[INFO] %s\n' "$1"; }

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  fail "tooling" "required tool '$1' not found on PATH"
  exit 3
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

# ---- helm-chart: repo + chart (+ optional version) exist -------------------
cmd_helm_chart() {
  local repo="" url="" chart="" version=""
  while [ $# -gt 0 ]; do case "$1" in
    --repo-name) repo="$2"; shift 2;;
    --repo-url)  url="$2";  shift 2;;
    --chart)     chart="$2"; shift 2;;
    --version)   version="$2"; shift 2;;
    *) fail "helm-chart" "unknown arg: $1"; exit 2;;
  esac; done
  [ -n "$repo" ] && [ -n "$url" ] && [ -n "$chart" ] || { fail "helm-chart" "need --repo-name --repo-url --chart"; exit 2; }
  need helm

  # repo add is idempotent; "already exists" with a different URL still errors,
  # which is itself a useful signal, so don't swallow everything.
  helm repo add "$repo" "$url" >/dev/null 2>&1 || true
  helm repo update "$repo" >/dev/null 2>&1 || true

  local args=(show chart "$repo/$chart")
  [ -n "$version" ] && args+=(--version "$version")
  if helm "${args[@]}" >/dev/null 2>&1; then
    pass "helm-chart" "$repo/$chart${version:+ @$version} exists"
    return 0
  fi
  fail "helm-chart" "$repo/$chart${version:+ @$version} not found in repo $url"
  return 1
}

# ---- helm-render: `helm template` the values, expect resources -------------
cmd_helm_render() {
  local repo="" url="" chart="" version="" values="" ns="default"
  while [ $# -gt 0 ]; do case "$1" in
    --repo-name) repo="$2"; shift 2;;
    --repo-url)  url="$2";  shift 2;;
    --chart)     chart="$2"; shift 2;;
    --version)   version="$2"; shift 2;;
    --values)    values="$2"; shift 2;;
    --namespace) ns="$2"; shift 2;;
    *) fail "helm-render" "unknown arg: $1"; exit 2;;
  esac; done
  [ -n "$repo" ] && [ -n "$chart" ] && [ -n "$values" ] || { fail "helm-render" "need --repo-name --chart --values"; exit 2; }
  [ -f "$values" ] || { fail "helm-render" "values file not found: $values"; exit 2; }
  need helm
  helm repo add "$repo" "$url" >/dev/null 2>&1 || true
  helm repo update "$repo" >/dev/null 2>&1 || true

  local args=(template release "$repo/$chart" -f "$values" --namespace "$ns")
  [ -n "$version" ] && args+=(--version "$version")
  local out err
  err="$(mktemp)"
  out="$(helm "${args[@]}" 2>"$err")"
  local rc=$?
  if [ $rc -ne 0 ]; then
    fail "helm-render" "helm template failed: $(head -3 "$err" | tr '\n' ' ')"
    rm -f "$err"; return 1
  fi
  rm -f "$err"
  # Must emit at least one resource (a kind: line). Count via a here-string
  # rather than `printf "$out" | grep -qE`: grep -q exits on the first match and
  # closes the pipe, so on large output (e.g. SigNoz's ~80KB render) the still-
  # writing printf takes SIGPIPE and, under `set -o pipefail`, the whole pipeline
  # reports failure even though a match was found.
  local n; n="$(grep -cE '^kind:' <<<"$out")"
  if [ "$n" -gt 0 ]; then
    pass "helm-render" "rendered $n resource document(s)"
    return 0
  fi
  fail "helm-render" "helm template produced no resources"
  return 1
}

# ---- manifest-validate: shape (apiVersion+kind per doc) + kubectl dry-run --
cmd_manifest_validate() {
  local file="" ns="default" shape_only=0
  while [ $# -gt 0 ]; do case "$1" in
    --file)      file="$2"; shift 2;;
    --namespace) ns="$2"; shift 2;;
    --shape-only) shape_only=1; shift;;
    *) fail "manifest-validate" "unknown arg: $1"; exit 2;;
  esac; done
  [ -f "$file" ] || { fail "manifest-validate" "file not found: $file"; exit 2; }
  need python3

  # Shape: every non-empty, non-comment document needs top-level apiVersion+kind.
  # Mirrors the in-app ManifestShape.validationError rules.
  local shape
  shape="$(python3 - "$file" <<'PY'
import sys
text=open(sys.argv[1]).read()
docs=[]; cur=[]
for line in text.split("\n"):
    if line.strip()=="---": docs.append("\n".join(cur)); cur=[]
    else: cur.append(line)
docs.append("\n".join(cur))
def topkey(line,key):
    return (not line[:1].isspace()) and (line==key or line.startswith(key+":"))
for i,doc in enumerate(docs):
    meaningful=[l for l in doc.split("\n") if l.strip() and not l.strip().startswith("#")]
    if not meaningful: continue
    has_api=any(topkey(l,"apiVersion") for l in meaningful)
    has_kind=any(topkey(l,"kind") for l in meaningful)
    if not (has_api and has_kind):
        miss=[m for m,h in (("apiVersion",has_api),("kind",has_kind)) if not h]
        pos=f"document {i+1}" if len(docs)>1 else "the manifest"
        print(f"{pos} is missing top-level {' and '.join(miss)} (near \"{meaningful[0].strip()[:60]}\")")
        sys.exit(1)
PY
)"
  if [ $? -ne 0 ]; then
    fail "manifest-shape" "$shape"
    return 1
  fi
  pass "manifest-shape" "every document has top-level apiVersion + kind"
  [ "$shape_only" -eq 1 ] && return 0

  need kubectl
  # Prefer server-side dry-run (validates against the live API); fall back to
  # client-side when no cluster is reachable, and say which ran (no silent cap).
  local err; err="$(mktemp)"
  if kubectl apply --dry-run=server -f "$file" -n "$ns" >/dev/null 2>"$err"; then
    pass "manifest-dry-run" "server-side dry-run accepted the manifest"
    rm -f "$err"; return 0
  fi
  if grep -qiE 'connection refused|no configuration|unable to connect|dial tcp|did you specify the right host' "$err"; then
    info "no cluster reachable — falling back to client-side dry-run (schema only)"
    if kubectl apply --dry-run=client -f "$file" -n "$ns" >/dev/null 2>"$err"; then
      pass "manifest-dry-run" "client-side dry-run accepted the manifest (server-side SKIPPED: no cluster)"
      rm -f "$err"; return 0
    fi
  fi
  fail "manifest-dry-run" "$(head -5 "$err" | tr '\n' ' ')"
  rm -f "$err"; return 1
}

# ---- image: existence + captured Entrypoint/Cmd ----------------------------
cmd_image() {
  [ $# -ge 1 ] || { fail "image" "need at least one IMAGE"; exit 2; }
  need docker
  need python3
  local any_fail=0
  for img in "$@"; do
    local raw
    if ! raw="$(docker buildx imagetools inspect "$img" --format '{{json .Image}}' 2>/dev/null)" || [ -z "$raw" ]; then
      fail "image" "$img — not found / not pullable"
      any_fail=1; continue
    fi
    # .Image is either a single config or a platform-keyed map; surface the
    # linux/amd64 (or first) Entrypoint/Cmd so the skill can lint command:.
    # (Pass JSON via a temp file: the heredoc already owns python's stdin.)
    local jf; jf="$(mktemp)"; printf '%s' "$raw" > "$jf"
    python3 - "$img" "$jf" <<'PY'
import sys, json
img=sys.argv[1]
d=json.loads(open(sys.argv[2]).read())
def cfg(o): return (o or {}).get("config",{}) if isinstance(o,dict) else {}
chosen=None
if isinstance(d,dict) and "config" in d:
    chosen=d
elif isinstance(d,dict):
    chosen=d.get("linux/amd64") or next(iter(d.values()), None)
c=cfg(chosen)
print(f"[PASS] image — {img} exists  Entrypoint={c.get('Entrypoint')}  Cmd={c.get('Cmd')}")
PY
    rm -f "$jf"
  done
  return $any_fail
}

[ $# -ge 1 ] || usage
sub="$1"; shift
case "$sub" in
  helm-chart)        cmd_helm_chart "$@";;
  helm-render)       cmd_helm_render "$@";;
  manifest-validate) cmd_manifest_validate "$@";;
  image)             cmd_image "$@";;
  -h|--help|help)    usage;;
  *) fail "usage" "unknown subcommand: $sub"; usage;;
esac
