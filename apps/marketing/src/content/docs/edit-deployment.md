---
title: "Edit a Deployment's config"
description: "Edit a Deployment's replicas, image, resources, env, and secrets through the confirm gate."
category: "Guides"
order: 6
icon: "lucide:layers"
---

Edit a Deployment's most-changed settings — replica count, per-container image, CPU/memory requests & limits, environment variables, **image-pull secrets**, and env vars **referenced from a Secret/ConfigMap key** — from a guided form, without hand-writing YAML. Like the rest of Rigel's mutations, nothing hits the cluster until you review the exact `kubectl` commands and confirm.

**Where:** **Deployments** panel → right-click a row → **Edit config…**, or expand a row → **Manage** → **Edit config**.

---

## How it works

The editor opens in a **wide centered dialog**. It's seeded from the Deployment's live spec, so you're editing what's actually running. You change fields, click **Review changes**, and Rigel diffs the form against the live spec into a small set of discrete actions — it only emits a command for what you actually changed. Each action is previewed as its **exact** `**kubectl**` **command** in the confirm step (the same batch-confirm flow the chat copilot uses), then run in order. The watch refreshes the panel automatically.

### What you can edit

* **Replicas** — desired replica count (`kubectl scale`).
* **Image** (per container) — the container image/tag (`kubectl set image`).
* **CPU / memory requests & limits** (per container) — `kubectl set resources`. A **cleared** resource field is treated as *no change* (kubectl `set resources` can't remove a request/limit), so clearing a box won't wipe an existing value.
* **Environment variables** (per container):
  * **Plain key/value** vars — add/edit/remove (`kubectl set env`, with `KEY-` to unset).
  * **From Secret / ConfigMap** *(new)* — give an env var a name and point it at a **key of an existing Secret or ConfigMap** (`valueFrom.secretKeyRef` / `configMapKeyRef`). The Secret/ConfigMap and its key are chosen from **live dropdowns** of what exists in the Deployment's namespace. This is the Rancher-style "add a variable from a resource".
  * Downward-API refs (`fieldRef` / `resourceFieldRef`, e.g. `POD_IP`) are shown **read-only** and can be removed but not edited.
* **Image pull secrets** *(new)* — attach one or more **registry secrets** so the Deployment can pull from a **private registry** (e.g. GHCR). Pick from a live dropdown of the namespace's docker-registry secrets (`kubernetes.io/dockerconfigjson` / `dockercfg`); selected ones show as removable chips. This edits the pod template's `imagePullSecrets`.

> **GHCR / private images:** a registry secret is **not** an environment variable — it belongs in **Image pull secrets**, not Environment. Use that section to let a Deployment pull `ghcr.io/you/private-app`.

### How changes are applied (per kind)

| You changed… | Action | kubectl |
|--------------|--------|---------|
| Replicas     | `scale` | `kubectl scale deployment/<n> --replicas=<r>` |
| Image        | `setImage` | `kubectl set image deployment/<n> <c>=<image>` |
| CPU/mem      | `setResources` | `kubectl set resources deployment/<n> -c <c> --requests/--limits` |
| Plain env (add/edit/remove) | `setEnv` | `kubectl set env deployment/<n> --containers=<c> KEY=val KEY-` |
| Env from Secret/ConfigMap | `setEnvRef` | `kubectl patch deployment/<n> --type=strategic` (adds `env[].valueFrom`) |
| Image pull secrets | `setImagePullSecrets` | `kubectl patch deployment/<n> --type=merge` (sets `imagePullSecrets`) |

A merge patch **replaces** the whole `imagePullSecrets` list (so removing the last one clears it). The strategic patch for env refs merges by env-var **name**, so it adds/updates only the referenced vars without touching the rest. Converting a plain var into a Secret/ConfigMap ref **unsets the plain value first**, then patches in the ref — so you never end up with an invalid `value` + `valueFrom` on the same variable.

---

## Notes & limitations

* **Edit only** — this edits an existing Deployment. To create one, use [Apply YAML](/docs/apply-yaml) or the catalog.
* **Deployments only (for now)** — the underlying actions support StatefulSets/DaemonSets (via `resourceKind`), but only the Deployments editor surfaces them.
* **Pick existing only** — you reference Secrets/ConfigMaps that already exist; the editor doesn't create them. Make the secret first (e.g. a GHCR `docker-registry` secret) via the Secrets panel or `kubectl`.
* **Live pickers** — while the editor is open it watches `secrets` and `configmaps` in the Deployment's namespace; if a secret was just created it appears in the dropdown without a manual refresh.
* Cleared CPU/memory fields are intentionally left unchanged (see above).

---

## Operational

* Actions run through `POST /api/action` (and `POST /api/action?preview=1` for the exact-command preview); the server maps each action kind to `kubectl` argv in `apps/server/src/actions.ts` (`buildCommand`).
* The two new web-only kinds are `setImagePullSecrets` (merge patch) and `setEnvRef` (strategic patch).
* Diff / edit-model logic: `editModelFor` + `diffDeployment` in `apps/web/src/panels/deployments/deploymentDisplay.ts` (unit-tested). UI: `DeploymentEditor.tsx`, `EnvRefEditor.tsx`, `ImagePullSecretsField.tsx` in `apps/web/src/panels/deployments/`.
* Behind the same session auth as the rest of the app.
