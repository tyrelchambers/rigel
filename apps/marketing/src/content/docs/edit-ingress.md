---
title: "Edit an Ingress (routing & TLS)"
description: "Edit an Ingress — routing rules and TLS — through the confirm gate."
category: "Guides"
order: 7
icon: "lucide:route"
---

Edit an Ingress's values — routing rules, TLS, ingress class, and annotations — from a guided form, without hand-writing YAML. It's the same guarded apply path the [Apply YAML](/docs/apply-yaml) and ConfigMap/Secret editors use: nothing hits the cluster until you confirm.

**Where:** **Ingresses** panel → right-click a row → **Edit…**, or expand a row → **Edit** (top-right of the detail).

---

## How it works

The editor opens in a bottom sheet with a **Form ⇄ YAML** toggle.

**Form mode** (default) gives you fields for:

* **Ingress class** — e.g. `nginx`.
* **Rules** — one or more `host → path → service:port` routes. Each rule has a host (blank = all hosts) and one or more paths; each path has a **path**, a **path type** (`Prefix` / `Exact` / `ImplementationSpecific`), and a backend **service name + port** (numeric like `80` or a named port like `http`). Add/remove rules and paths inline.
* **TLS** — zero or more `hosts → secretName` entries (hosts comma-separated).
* **Annotations** — key/value rows (this is where cert-manager / nginx annotations live, e.g. `cert-manager.io/cluster-issuer: letsencrypt-prod`).

A live **preview** at the bottom shows the exact `kubectl apply -f -` command and the YAML that will be applied.

**YAML mode** shows that same manifest as an editable text area — drop into it for anything the form doesn't cover, then **Apply**. Switching back to **Form** rebuilds the YAML from the fields (raw edits are discarded), so do your final tweaks in whichever mode you'll apply from.

**Apply changes** runs `kubectl apply -f -` with the manifest. The watch refreshes the panel automatically.

---

## What's preserved

* **Name and namespace** are read-only (a resource's identity is immutable — to "rename" you'd create a new one).
* **Labels** are carried through unchanged.
* **Annotations** are fully editable; the noisy `kubectl.kubernetes.io/last-applied-configuration` annotation is hidden (kubectl re-creates it on apply).
* Server-managed fields (uid, resourceVersion, creationTimestamp, status) are dropped from the applied manifest.

---

## Notes & limitations

* **Edit only** — this edits an existing Ingress. To create one from scratch, use **Apply YAML** or the catalog.
* **Apply semantics** — it's `kubectl apply` (create-or-update / 3-way merge). Removing a rule/annotation in the form removes it from the object on apply.
* **`defaultBackend`** isn't surfaced in the form (rules/TLS/annotations/class are). Use YAML mode for it.
* No YAML library is bundled — the manifest is built by a hand-rolled emitter (`packages/k8s/ingressEditor.ts`), the same no-dependency approach as the ConfigMap/Secret editors. All the build/validation logic is unit-tested there.

---

## Operational

* Applies via `POST /api/apply` with `{ yaml }` (the same endpoint as Apply YAML), behind the session auth.
* Pure logic: `buildIngressYAML` / `ingressToInput` / `canSubmitIngress` in `packages/k8s/src/ingressEditor.ts`; the sheet UI is `apps/web/src/panels/ingresses/IngressEditor.tsx`.
