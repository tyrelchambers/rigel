// ConfigMap type for the web ConfigMaps panel. Mirrors the Swift `ConfigMap`
// in `Sources/Helmsman/Cluster/ConfigMap.swift` and the normative spec in
// `docs/parity/configmaps.md`. ConfigMaps are namespace-scoped.
//
// In the raw kubectl `-o json` watch stream, `data` holds plaintext key/value
// pairs and `binaryData` holds base64-encoded values. Both are optional.

export interface ConfigMap {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601
    labels?: Record<string, string>;
  };
  /** Plaintext key/value pairs. */
  data?: Record<string, string>;
  /** Binary key/value pairs; values are base64-encoded. */
  binaryData?: Record<string, string>;
}
