---
title: "Alerts: watch it in plain English"
description: "Describe what you want watched in a plain sentence and Rigel turns it into a live background alert that pings your phone."
category: "Guides"
order: 11
icon: "lucide:bell-ring"
---

Type what you want to watch as a plain sentence, like "text me if the postgres database goes down", and Rigel turns it into a live watch that runs in the background. When the rule trips you get a notification on your phone. The in-cluster agent does the watching itself, so there's no Prometheus or Alertmanager to stand up for the event-based rules.

**Where:** **Alerts**. Write a rule in plain English, or pick a condition, and it starts watching.

---

## Writing a rule

Describe the thing you care about in one sentence and Rigel builds the watch for you: "page me when a pod crash-loops in the `payments` namespace", "let me know if a node goes NotReady", "alert me if node memory goes over 90%". You don't wire up queries or thresholds by hand, you say what "bad" looks like and Rigel keeps an eye on it.

## Conditions you can watch

* **Pod restarts**: a container restarting.
* **Crash loops**: a pod stuck in `CrashLoopBackOff`.
* **OOM kills**: a container killed for running out of memory.
* **Pods pending too long**: workloads that can't get scheduled.
* **Node NotReady**: a node dropping out of the cluster.
* **Deployment degraded**: a workload running below its desired replicas.
* **Metric thresholds**: node CPU % and memory % crossing a limit you set.

## Where alerts go

When a rule trips you get a notification through whichever channel you've set up:

* **Signal**
* **Matrix**
* **Discord**
* **Slack**
* A generic **webhook** for anything else.

## Cutting the noise

* **Quiet hours**: set a window so you don't get paged overnight.
* **Per-rule cooldowns**: after a rule fires it holds off before firing again, so a flapping pod doesn't bury you in messages.

---

## Notes & limitations

* Alerts are evaluated by the **in-cluster agent**, so this needs the agent installed. If the agent isn't running, nothing is being watched.
* The **event-based rules** (restarts, crash loops, OOM kills, pending pods, NotReady nodes, degraded deployments) work on their own, no metrics backend required.
* The **metric-threshold rules** (node CPU %, node memory %) need a metrics source in the cluster, either `metrics-server` or a Prometheus-compatible backend. Without one, those thresholds have nothing to read.
* Notifications land on your phone through a chat channel or webhook. There's no SMS or phone-call paging.
