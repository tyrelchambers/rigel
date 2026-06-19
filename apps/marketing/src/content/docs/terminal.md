---
title: "Terminal — interactive cluster shell"
description: "An interactive shell into your cluster, right inside Rigel."
category: "Guides"
order: 4
icon: "lucide:square-terminal"
---

A Rancher-style **interactive shell**, docked as a drawer at the bottom of the screen, for running one-off `kubectl` / `helm` / shell commands without leaving whatever panel you're on. It's a real terminal (colors, line editing, interactive programs like `kubectl edit`), wired to the same cluster the rest of Rigel uses.

---

## Open / close it

The terminal is a **drawer**, not a page — so it overlays the bottom of the content area and you can keep it open while you navigate.

* **⌃\`** (Control + backtick) toggles it from anywhere, **or**
* click the **Terminal** chip in the bottom **status bar**.

> It deliberately isn't in the sidebar or the ⌘K command palette — it's an always-a-keystroke-away tool, not a destination.

**Resize** by dragging the drawer's top edge (the height is remembered).

---

## It stays alive

The drawer is **kept mounted**, so hiding it or navigating to another panel **doesn't kill your shell** — the session and scrollback persist until you close the tab. Re-open with ⌃\` and you're right back where you were.

If the shell process exits (e.g. you type `exit`), the drawer shows a **Restart shell** button.

---

## What you can run

A full `bash` with the cluster tooling baked in: `**kubectl**`, `**helm**`, `**jq**`, plus the `kubectl cnpg` and `kubectl cert-manager` plugins. It inherits the server's environment, so it talks to the **same cluster / kubeconfig / context** as the app — no extra auth or `--context` juggling.

```sh
kubectl get pods -A
kubectl get deploy api -n personal -o json | jq '.spec.template.spec.containers[].resources'
helm list -A
```

> ⚠️ This is a **full shell with the app's cluster access** (Rigel is a cluster-admin tool). Anyone who can log in can run anything here — protect Rigel with auth and network controls as usual.

---

## Notes & limitations

* **Single shell (v1)** — one terminal session per connection. Multiple tabs/sessions are a planned extension.
* Runs **in the Rigel server container** under the app's context (not an isolated per-user sandbox).
* Behind the same session auth as the rest of the app; the terminal streams over the authenticated `/ws` WebSocket.
