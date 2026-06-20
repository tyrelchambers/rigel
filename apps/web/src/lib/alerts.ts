// Re-export the shared alert-rule domain helpers for the chat + Assistant panel.
export {
  type AlertRule,
  type AlertTarget,
  type AlertCondition,
  type SuggestedAlert,
  parseAlertRules,
  alertRuleSummary,
} from "@rigel/k8s";
