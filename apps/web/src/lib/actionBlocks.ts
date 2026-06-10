// Re-export the shared action-block parser. The implementation lives in
// packages/k8s so the chat panel and the server bridge decode the fenced
// ```action JSON identically (see docs/parity/contracts.md § 1).
export {
  type SuggestedAction,
  ACTION_KINDS,
  extractActionBlocks,
  stripActionBlocks,
  parseSuggestedActions,
} from "@helmsman/k8s";
