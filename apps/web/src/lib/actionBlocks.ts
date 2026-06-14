// Re-export the shared action-block parser. The implementation lives in
// packages/k8s so the chat panel and the server bridge decode the fenced
// ```action JSON identically (see docs/parity/contracts.md § 1).
export {
  type SuggestedAction,
  type SuggestedQuestion,
  type QuestionField,
  ACTION_KINDS,
  extractActionBlocks,
  extractQuestionBlocks,
  stripActionBlocks,
  parseSuggestedActions,
  isDestructiveAction,
  buildQuestionAnswer,
} from "@helmsman/k8s";
