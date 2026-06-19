---
title: "Apply YAML — create a one-off resource"
description: "Create or update a one-off resource by applying raw YAML through the confirm gate."
category: "Guides"
order: 5
icon: "lucide:file-code"
---

Paste a Kubernetes manifest and apply it straight to the cluster — for quick one-off resources (a ConfigMap, a test Deployment, an Ingress) without writing a file, leaving the UI, or using the catalog. It's the same guarded apply path the catalog installer uses, so nothing hits the cluster until you've validated and confirmed.

**Where:** **Tools → Apply YAML** (`/apply`).

---

## How it works

1. **Paste** any manifest into the editor. Multi-document YAML (separated by `---`) is supported — paste a whole bundle at once.
2. **Validate** — runs a **server-side dry run** (`kubectl apply --dry-run=server -f -`). The apiserver checks and admits the manifest **without persisting anything**. You get back either:
   - a green summary listing each resource it would create/update (kind · name · namespace), or
   - the apiserver's exact error (bad field, missing CRD, schema violation, …).
3. **Apply…** — opens the standard **confirm sheet** showing the resources to be applied, then runs `kubectl apply -f -` on confirm.

The YAML is piped to `kubectl` over **stdin** — never interpolated into a shell — so it's safe to paste arbitrary content.

> **Tip:** Validate first. The dry run catches most mistakes (typos, wrong apiVersion, missing CRDs) before anything touches the cluster.

---

## Namespaces

The namespace comes from **each document's** `metadata.namespace`. If a document omits it, `kubectl` falls back to the default/current namespace — Rigel surfaces this rather than silently injecting one, so set `namespace:` explicitly when it matters.

---

## Notes & limitations

- **Apply semantics** — this is `kubectl apply`, i.e. **create-or-update**. Re-applying an edited manifest updates the existing resource.
- **No delete here** — to remove resources use the relevant resource panel (or "Purge an app" for a whole app).
- Same RBAC as the rest of Rigel — the apply runs as the app's ServiceAccount.

---

## Operational

- Endpoint: `POST /api/apply` with `{ yaml, dryRun? }` — `dryRun: true` runs `--dry-run=server`; otherwise it applies. Returns `{ code, stdout, stderr }`.
- Behind the same session auth as the rest of the app.
