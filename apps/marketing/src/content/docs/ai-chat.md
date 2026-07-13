---
title: "AI chat: your cluster copilot"
description: "An in-app chat copilot that investigates your cluster in plain English and proposes fixes you approve before anything runs."
category: "Guides"
order: 9
icon: "lucide:message-square-text"
---

A persistent chat copilot lives alongside the app. Ask about your cluster in plain English and it investigates using structured read tools, streaming its thinking and its answer as it goes. It reads on its own but never changes anything on its own: when it wants to fix something it hands you a button, and the exact `kubectl` command is shown before it runs.

**Where:** the **chat pane**, docked alongside every panel. Any panel can hand you off to it with context already loaded.

---

## Ask about your cluster

Type a question the way you'd ask a teammate: *why is this pod restarting?*, *what's using the most memory in `payments`?*, *is this rollout stuck?* The copilot picks the right read tools, gathers what it needs across your cluster, and streams its reasoning and the answer back as it works, so you can follow along and stop early once you've seen enough.

Chat history is kept, so you can scroll back through an investigation or pick up where you left off.

## Fixes are proposed, never applied

The copilot cannot change your cluster by itself. When it decides on a fix, it renders an **action block** as a button instead of running anything. Click it and a guarded **confirm sheet** opens showing the exact `kubectl` command it intends to run. Nothing happens until you approve; no click, no change.

Actions it can propose include:

* **Restart**, **scale**, or **rollback** a workload.
* **Set env / image / resources** on a workload.
* **Pause** or **resume** a rollout.
* **Delete** a pod or a workload.
* **Cordon**, **uncordon**, or **drain** a node.
* **Create** or **delete** a namespace.
* **Apply a manifest**.

## Pull resources and context into the chat

* **`@`-mention** any resource, a pod, deployment, service, and so on, to drop it into the conversation. Autocomplete finds it as you type.
* **`/` commands** are available right in the composer.
* **Right-click** a resource, a log line, or an event and choose **Ask** to hand that item, along with the surrounding lines, straight to the chat so it can investigate in context.
* From any panel, hand off **what you're currently viewing** to the chat with its context preloaded.

## Bring your own model

The chat runs on the AI model *you* choose: **Claude**, **Codex**, **Gemini**, or **OpenCode**, using your own key or credentials. Pick a fast model for quick looks and a heavier one for hard problems, and switch as the task demands.

---

## Notes & limitations

* The chat needs an AI CLI on your `PATH` (for example `claude`) and your own key or credentials. There's no bundled or managed AI, and it doesn't work offline.
* It only **reads** on its own. Every change is a proposed action you approve in the confirm sheet, which shows the exact command first.
* Rigel is a macOS desktop app; the read and observe panels work without an AI key, but the chat copilot doesn't.
