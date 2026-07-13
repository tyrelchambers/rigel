---
title: "Clusters: connect, switch & create"
description: "Switch between your clusters from a rail, connect existing cloud or kubeconfig clusters, and spin up a local kind or k3d cluster for testing."
category: "Guides"
order: 13
icon: "lucide:git-branch"
---

A rail down the side lists your clusters. Click one and the whole app re-points at that cluster, panels, logs, chat, and all. One cluster is active at a time; this is a switcher, not a fleet dashboard that shows everything at once. Rigel uses the kubeconfig already on your machine and connects out to each cluster directly, so there's no Rigel server in the middle.

**Where:** the cluster rail down the left edge, present on every screen.

---

## Switching clusters

Each entry in the rail is one cluster. Click it to make it active, and the rest of the app follows: reads, live watches, logs, and the chat copilot all re-point at that cluster. Give each cluster a **custom name and icon** so a glance at the rail tells you where you are.

Only one cluster is active at a time. Switching is a re-point, not a merge, you're always looking at exactly one cluster.

## Connecting existing clusters

Add a cluster you already run. Rigel supports:

* **Amazon EKS**
* **Google GKE**
* **Azure AKS**
* **DigitalOcean Kubernetes (DOKS)**
* **Import an existing kubeconfig / context** already on your machine.

These are **connect / import only**, Rigel points at a cluster that already exists and does not create or provision anything in the cloud. Each connect flow detects **expired auth** and, if something is denied, tells you **which permission is missing** so you know what to fix.

## Creating a local cluster

Rigel can create a **local** cluster from the app using **kind** or **k3d**, with a **version picker** and **tool auto-detection**. This is for a throwaway test environment on your own machine.

Creating clusters is **local only**. Cloud providers (EKS / GKE / AKS / DOKS) are connect / import only, Rigel never creates or provisions clusters in the cloud. Deleting is guarded to clusters **Rigel created**, so you can't delete a cluster you only connected to.

## Namespace scoping

Narrow the whole app to a single namespace, or open it back up to all namespaces. The scope applies across panels for the active cluster, so you can focus on one team's or one app's namespace without the rest of the cluster in the way.

---

## Notes & limitations

* **One active cluster at a time.** The rail is a switcher, not a simultaneous multi-cluster fleet view.
* **Cluster creation is local only** (kind / k3d). Cloud providers are connect / import only, Rigel does not provision cloud clusters.
* **Delete is guarded** to clusters Rigel created; connected clusters can be removed from the rail but are never destroyed.
* Rigel connects **directly** using your local kubeconfig, there's no Rigel server in between. A connection is only as good as the credentials and reachability that kubeconfig already has.
