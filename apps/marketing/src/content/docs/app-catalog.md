---
title: "The app catalog"
description: "A catalog of self-hostable apps you install onto your own cluster in a few clicks."
category: "Guides"
order: 12
icon: "lucide:package"
---

Browse a catalog of 58 self-hostable apps and install any of them onto your own cluster in a few clicks. A guided wizard fills in sensible defaults, each app ships with resource presets that already work, and a node-fit check confirms the target node has room before you commit. Everything runs on your hardware, so your data stays with you and there's no monthly bill.

**Where:** **Catalog** (`/catalog`). Pick an app to open its install wizard.

---

## Browsing the catalog

Apps are grouped by category so you can find what you need:

* **Dev tools**: e.g. Gitea.
* **Productivity**: e.g. Nextcloud, n8n.
* **Databases**: e.g. MinIO.
* **Media**: e.g. Immich, Jellyfin.
* **Networking**: e.g. Vaultwarden.
* **Observability**: e.g. Uptime Kuma, Plausible, Metabase.

Each entry describes what the app does and what it needs, so you can decide before you start.

## The install wizard

Picking an app opens a guided wizard that asks for the essentials with defaults already filled in:

* **Namespace**: where the app lands.
* **Hostname**: how you'll reach it.
* **Storage**: how much persistent volume to request.

Every app ships with **CPU/memory presets** that work, so you're not guessing at limits. A **node-fit check** tells you whether the target node can accommodate the app's requests before you install, catching an over-subscribed node up front rather than after a pod fails to schedule.

## After it's installed

* **Update notifications**: Rigel flags when an installed app has a newer version available, so you know when there's an upgrade to pick up.
* **Full uninstall / purge**: when you're done with an app, Rigel finds every piece of it, has you type the name to confirm, and removes it all: no leftover volumes, secrets, or config.

---

## Notes & limitations

* Apps install to **your** cluster. This is self-hosting on your own hardware, not a Rigel-hosted or managed service.
* The catalog currently covers **58 apps** across the categories above.
* Presets and defaults are a sensible starting point; adjust namespace, hostname, storage, and resources to fit your environment.
