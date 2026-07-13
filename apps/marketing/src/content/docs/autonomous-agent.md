---
title: "The autonomous agent"
description: "An opt-in in-cluster agent that watches your allowlisted namespaces and remediates common issues within the limits you set."
category: "Guides"
order: 10
icon: "lucide:shield-check"
---

Rigel can run an **opt-in agent inside your own cluster** that watches your allowlisted namespaces around the clock and fixes issues it knows how to handle, within limits you set. You deploy it yourself as its own service, choose how much it does on its own, and keep a human in the loop for anything it won't decide alone. It runs in a tight RBAC cage that can't read your Secrets, and every action is logged with a before/after and an undo.

**Where:** deploy it from **Assistant** (the guided install), then manage autonomy, guardrails, the **Needs You** queue, and the activity timeline from there.

---

## Install & uninstall (opt-in)

The agent is off until you deploy it. A **guided install** sets up everything it needs inside your cluster:

* **RBAC** for the agent's service account (the cage it operates in).
* **ConfigMaps** for its configuration.
* A **Secret** for its AI subscription token.
* A **Deployment** that runs the agent as its own service.

There's a **guided uninstall** to remove all of that cleanly. The agent needs an **AI subscription token** to run, and Rigel **tracks the token's expiry** so you know before it lapses.

---

## Autonomy modes

You choose how much the agent does on its own:

* **Auto**: it remediates issues it knows how to handle without waiting on you.
* **Advisory**: it surfaces what it would do and waits for your approval.
* **Quiet-hours**: it holds back during the hours you set.

Whatever the mode, it only ever acts in your **allowlisted namespaces**.

---

## What it watches and fixes

It watches your allowlisted namespaces continuously and remediates common failures within your limits:

* **Crash loops** (`CrashLoopBackOff`).
* **OOM kills**.
* Pods **stuck pending**.
* **Rollouts going sideways**.
* A **node going `NotReady`**.

---

## Guardrails

The agent is bounded on every side:

* **Kill-switch**: turn it off anytime. If it can't read its own config, it **shuts down rather than guess**.
* **Circuit breaker** with hard caps: **per-resource-per-hour**, a **nightly total**, and **per-incident attempts**.
* **Spend cap**: a hard dollar limit on the agent's own AI spend.
* **YAML snapshot**: it snapshots a resource's manifest **before** changing it.
* **Audit + undo**: every action is logged with a before/after and an **undo**.
* **RBAC cage**: it **never touches Secrets** and can't read them.

Anything the agent won't decide on its own goes into a **Needs You** queue for you to approve.

---

## Activity & incident timeline

The agent keeps an **activity / incident / audit timeline** of everything it's done, so you can see what happened, when, and why, with the before/after and undo attached to each action.

---

## Auto-fix PRs (opt-in per project)

When a fix belongs in **code** rather than the live cluster, the agent can open a pull request instead. Per project, you opt in; then when a fix belongs in the repo, it **clones your linked GitHub repo, branches, commits, and opens a pull request** for you to review. There's a **daily cap** and a **recent-PR list**.

**GitHub only**: auto-fix PRs don't support other providers.

---

## Scheduled digests

The agent can send a **plain-English cluster summary to your phone** on a **cadence you set**, so you get a periodic readout without opening the app.

---

## Notes & limitations

* **Opt-in**: nothing runs until you deploy the agent into your own cluster.
* **AI token required**: the agent needs an AI subscription token; Rigel tracks its expiry.
* **Allowlisted namespaces only**: it never acts outside the namespaces you allow.
* **Never touches Secrets**: its RBAC cage can't read them.
* **Auto-fix PRs are GitHub-only**: no GitLab or Bitbucket.
* **Human-in-the-loop by design**: anything outside its guardrails, or that it won't decide alone, waits for you in the **Needs You** queue.
