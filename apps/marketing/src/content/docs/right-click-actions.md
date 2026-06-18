---
title: "Right-click actions (context menus)"
description: "Right-click any resource for context-menu actions and quick Ask-the-Helmsman handoff."
category: "Guides"
order: 8
icon: "lucide:mouse-pointer-click"
---

Right-click any row in a list panel for a quick **context menu** of actions on that resource — the same actions available in the row's expanded "Manage" area, one click away. This mirrors the Swift app's right-click menus.

The menu **overrides the browser's native menu** and is styled to match the app (hover-highlighted items, keyboard navigable).

---

## Where it works

Every list panel: **Deployments, Pods, Workloads** (StatefulSets/DaemonSets/Jobs/CronJobs), **Services, Ingresses, Namespaces, Storage** (PVCs/PVs/StorageClasses), **Databases, ConfigMaps, Secrets, RBAC** (SA/Role/RoleBinding/ClusterRole/ClusterRoleBinding), **Certificates, Events, Right-sizing**, plus **Nodes** and **Logs**.

---

## What's in the menu

Each panel's menu is built from that panel's own actions, so it's contextual. Common shape:

* **Ask Claude: Errors / Logs / Explain** — hands the resource to the chat copilot for that question (where the panel supports it).
* **The panel's mutations** — e.g. Deployments: Restart / Scale / Rollback / Pause·Resume; Pods: Delete; Workloads: Restart/Scale/Delete + CronJob Suspend/Trigger; Nodes: Cordon/Uncordon, Drain; ConfigMaps/Secrets: Edit; Databases: the CNPG actions (back up, switchover, hibernate, …). Mutations still run through the normal **confirm sheet**.
* **View YAML…** — see [below](#view-yaml).
* **Move to namespace…** — deployments only, see [below](#move-to-namespace).
* **Manage… / Details…** — expands the row's detail panel.

Destructive items (Delete, Drain) are shown in red.

> **Nodes** wrap each node card; **Logs** put the menu on each log line (right-click a line → *Ask Claude about this line* / *Copy line*).

---

## View YAML

**Right-click → View YAML…** opens a read-only dialog with the resource's full manifest — fetched fresh via `kubectl get <kind> <name> -o yaml`, so it's the canonical server representation (not a cached copy). There's a **Copy** button. Works for namespaced and cluster-scoped kinds alike.

Backed by `GET /api/resource?kind=&name=&namespace=` (read-only).

---

## Move to namespace

Kubernetes has **no native "move"** — a resource's namespace is immutable. So **Deployments → right-click → Move to namespace…** picks a target namespace and hands a **clone-then-delete plan to the chat copilot**, which:

1. Creates the target namespace if needed.
2. Discovers related resources (Services, ConfigMaps, Secrets, Ingresses, PVCs).
3. Recreates each in the target namespace (stripping server-assigned fields), **gated through the confirm flow** at each step.
4. Verifies the new pods are healthy.
5. Only then deletes the originals.

> ⚠️ **PVC data does not follow.** A recreated PVC binds to a new, empty volume — the copilot stops and asks before touching storage. Review each step; nothing is bulk-deleted before the new namespace is confirmed working.

---

## Notes & limitations

* **Logs**: the menu is per log line (Ask Claude about this line / Copy line), not the panel's actions.
* **Move to namespace** is currently **Deployments only** (the rich, related-resource-aware flow). Other kinds can be moved by asking the copilot directly.
* **Connectivity** rows are read-only (navigation only).
* Built on one shared primitive (`components/ui/context-menu.tsx`, Base UI) wired through the shared `ListRow`, so every panel stays consistent.
