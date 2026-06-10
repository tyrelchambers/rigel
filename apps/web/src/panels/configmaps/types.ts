// ConfigMap type for the web ConfigMaps panel. Re-exported from the shared
// `@helmsman/k8s` package so the panel, the editor, and the shared YAML builders
// all agree on one definition. Mirrors the Swift `ConfigMap` in
// `Sources/Helmsman/Cluster/ConfigMap.swift` and `docs/parity/configmaps.md`.
//
// In the raw kubectl `-o json` watch stream, `data` holds plaintext key/value
// pairs and `binaryData` holds base64-encoded values. Both are optional.

export type { ConfigMap } from "@helmsman/k8s";
