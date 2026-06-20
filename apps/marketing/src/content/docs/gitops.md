---
title: "GitOps: deploy from a Git repo"
description: "Deploy and sync applications straight from a Git repository."
category: "Guides"
order: 3
icon: "lucide:git-branch"
---

Rigel can deploy Kubernetes manifests straight from a **GitHub repo**, and, once an app is linked to its repo, let the AI propose fixes as **pull requests**. It's a lightweight, manual-trigger GitOps: you stay in control (every apply is previewed with a diff and confirmed), the repo stays the source of truth.

> Sync is **manual** ("Sync now"); there's no background polling or webhooks yet. See [Current limitations](#current-limitations).

A repo can hold **several independently-deployable apps** (e.g. a monorepo with `apps/marketing/k8s`, `apps/web/k8s`, `apps/server/k8s`). GitOps models this directly: one **repo** owns a shared branch + token and a list of named **deployments** (manifest folders), each with its own **Sync now**, sync status, and workload links. You don't register the same repo three times.

---

## 1. Connect GitHub (one token)

GitOps uses a **single account-level GitHub Personal Access Token (PAT)** for everything: listing your repos, cloning, applying, and opening fix-PRs. It's managed in one place: **Accounts → Source control → GitHub**.

* Click **Create a personal access token**, which links to GitHub's classic-token page pre-scoped to `**repo**` (which covers clone/push **and** opening PRs).
* Paste the `ghp_…` token and **Connect**. Rigel validates it against the GitHub API (`/user`) and shows **"Connected as \<you\>"**.
* The token is stored as a cluster **Secret** (`rigel-github`) and is never shown again or returned to the browser.

> You don't have to visit Accounts first; the **Add repo** flow will prompt you for the token the first time if you're not connected yet.

To revoke, click **Disconnect** (deletes the Secret).

---

## 2. Add a repo and its deployments

Open **GitOps → Add repo**. It's a short wizard:

1. **Connect**, only shown if GitHub isn't connected yet (same token step as above).
2. **Pick a repo**, a searchable list of your repos (type to filter). Selecting one auto-fills the **Repo name** and **Branch** (the repo's default branch).
3. **Queue deployments**, a folder browser. It starts at the repo **root** and loads one level at a time; click a folder to descend, use the breadcrumb to go back up. Click **Add this folder** to turn the current folder into a **deployment**, and repeat for as many folders as you want. Each is auto-named from its path (e.g. `apps/marketing/k8s` → `marketing`); the name is editable and is a **globally-unique** id across all repos. **Add repo** saves them all.

To add more later, each repo card has **Add deployment** (the same folder browser scoped to that repo).

Sources are stored in the `rigel-git-sources` **ConfigMap** (no tokens, since those stay in the Secret), so they survive restarts. Repos created before this change are migrated automatically to a single deployment named after the old source, so existing links keep working.

---

## 3. Sync now (per deployment)

Each **deployment** row has its own **Sync now** button. Syncing:

1. Shallow-clones the repo's branch into the container.
2. Runs `kubectl diff` on that deployment's folder and shows you exactly **what will change** (a preview, nothing is applied yet).
3. On **Apply**, runs `kubectl apply -f <folder> -R` against the cluster.
4. Records the last-synced commit, time, and status on that deployment row.

On a successful sync, the applied resources are **stamped** with provenance annotations, `rigel.dev/source-repo` (the **deployment** name) and `rigel.dev/source-path`, so Rigel (and the AI) can map a running workload back to its repo + folder. See [Linking](#4-link-an-existing-workload-to-a-deployment).

> **Manual only.** There's no auto-sync on push yet, so you click Sync. Removed manifests are **not** pruned from the cluster.

---

## 4. Link an existing workload to a deployment

If you deployed an app some other way (manually, catalog, an existing cluster) and want the AI to understand it (and be able to open fix-PRs), **link the workload to a GitOps deployment**. Linking just stamps the same `rigel.dev/source-repo` annotation that a sync would; it doesn't move or re-deploy anything.

Linking is **bidirectional**:

* **From a workload:** Deployments → expand a row → **Manage** → **Link to GitHub** → pick a deployment (shown as `repo/deployment`), and **Unlink** there later.
* **From a deployment:** the GitOps deployment row lists its **linked workloads** and has **Link workload** to add one (and a × to unlink each).

Every link is run through the standard confirm sheet (it's a `kubectl annotate` under the hood).

> The link UI currently targets **Deployments**. StatefulSets/DaemonSets are supported by the underlying action but don't have a button yet.

---

## 5. AI fix → pull request

Once a workload is linked to a deployment, the chat copilot can fix it **in the repo** instead of patching the live cluster:

1. You ask the AI about a broken app (e.g. an OOMKilled deployment). It reads the `rigel.dev/source-repo` annotation to find the deployment → its repo + folder.
2. It proposes the change as an **Open PR** button. Clicking it opens the confirm sheet with a **readable diff** of the manifest change, a GitHub-style unified diff with old/new line-number gutters, color-coded additions/removals, hunk separators, a `+/−` change summary, and a copy button. Nothing is applied to the cluster.
3. On confirm, Rigel creates a branch, commits the change, pushes, and **opens a pull request** via the GitHub API. You get the PR link.
4. You review and merge on GitHub, then **Sync now** to roll it out.

This keeps the repo as the source of truth and keeps a human in the loop (PR review). It needs the workload **linked to a deployment** (§4) and the account PAT with `repo` scope (§1).

---

## Where state lives (operational)

| Thing | Where |
|-------|-------|
| Repo configs (repo, branch, deployments[], per-deployment last-sync) | `rigel-git-sources` ConfigMap (no secrets) |
| GitHub PAT + login | `rigel-github` Secret |
| Cloned repos | ephemeral, under `/tmp` (re-cloned each sync) |
| Provenance / link | `rigel.dev/source-repo` (deployment name) + `rigel.dev/source-path` annotations on the workload |

API endpoints (all behind the same session auth as the rest of the app): `GET/POST/DELETE /api/git/account`, `GET /api/git/repos`, `GET /api/git/repo-tree`, `GET/POST/DELETE /api/git/sources` (repo upsert/remove), `POST/DELETE /api/git/sources/deployment` (add/remove one deployment), `POST /api/git/sync` (`{repo, deployment}`), `POST /api/git/propose-fix`.

---

## Current limitations

* **Manual sync only**: no background polling or push-webhook auto-deploy yet.
* **No pruning**: manifests deleted from the repo aren't removed from the cluster on sync.
* **Per-deployment, not whole-repo**: there's no "sync all deployments in this repo" button yet; you sync each one.
* **Single branch per repo**: all deployments in a repo share its branch (no per-deployment branch).
* **Link UI is Deployments-only**: StatefulSets/DaemonSets need a UI affordance (the action supports them).
* **Classic PAT, `repo` scope**: fine-grained tokens aren't wired into the create-token link yet.

---

## Typical end-to-end

1. **Accounts → Source control → Connect GitHub** (paste a `repo`-scoped PAT).
2. **GitOps → Add repo** → search a repo → browse to each manifest folder → **Add this folder** for each → **Add repo**.
3. On a deployment row, **Sync now** → review the diff → Apply.
4. (For pre-existing apps) link the workload to a deployment from its **Manage** row.
5. Ask the chat to fix an issue → review the **PR** it opens → merge → **Sync now**.
