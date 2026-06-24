/**
 * chatHandoffPrompts — helpers to build the standard Errors / Logs / Explain
 * (and Rollout for deployments) prompts for a given resource kind/name/namespace.
 *
 * These match the wording already established in DeploymentsPanel and are
 * extracted here so every list panel can produce consistent prompts without
 * duplicating the strings.
 */
import type { K8sEvent } from "@/panels/events/types";

export type ChatTopic = "Errors" | "Logs" | "Explain" | "Rollout";

/**
 * Build the Rigel chat prompt for a given topic + resource.
 *
 * @param kind       - Kubernetes resource kind, lowercase (e.g. "deployment", "pod")
 * @param name       - Resource name
 * @param namespace  - Resource namespace (defaults to "default")
 * @param topic      - Which aspect to ask about
 */
export function buildHandoffPrompt(
  kind: string,
  name: string,
  namespace: string | undefined,
  topic: ChatTopic,
): string {
  const ns = namespace ?? "default";
  switch (topic) {
    case "Errors":
      return `Investigate errors on ${kind} ${name} in namespace ${ns} — check pod statuses, recent events, and crash/restart reasons.`;
    case "Logs":
      return `Show and summarize recent logs for ${kind} ${name} in namespace ${ns}.`;
    case "Explain":
      return `Explain what ${kind} ${name} in namespace ${ns} does and its current state.`;
    case "Rollout":
      return `Show the rollout status and recent rollout history of ${kind} ${name} in namespace ${ns}.`;
  }
}

/**
 * Build the "Move a deployment (+ related resources) to another namespace" chat
 * handoff prompt — there's no native k8s move, so the AI recreates everything in
 * the target namespace then deletes the originals, each step gated through the
 * confirm flow. Ported from the Swift ContextHandoffBuilder.moveDeploymentPrompt.
 */
export function moveToNamespacePrompt(name: string, srcNamespace: string | undefined, targetNamespace: string): string {
  const src = srcNamespace ?? "default";
  return [
    `Move the deployment **${name}** from namespace **${src}** to namespace **${targetNamespace}**, along with its related resources.`,
    ``,
    `There is no native "move" in Kubernetes — recreate each resource in \`${targetNamespace}\`, then delete the original in \`${src}\`. Work step by step and let me confirm each change via the app's action buttons (or \`kubectl apply\` so the confirm modal gates it) — don't ask me to type "yes".`,
    ``,
    `## Steps`,
    `1. If namespace \`${targetNamespace}\` doesn't exist, create it first.`,
    `2. Discover what belongs to this deployment using read-only \`kubectl get -o yaml\`:`,
    `   - the Deployment \`${name}\` itself;`,
    `   - **Services** whose selector matches its pod labels;`,
    `   - **ConfigMaps** and **Secrets** referenced by the pod spec (\`envFrom\`, \`env[].valueFrom\`, volumes, \`imagePullSecrets\`);`,
    `   - **Ingresses** that route to the matched Service(s);`,
    `   - **PersistentVolumeClaims** used by the pods.`,
    `3. For each, produce a clean manifest for \`${targetNamespace}\`: set \`metadata.namespace: ${targetNamespace}\` and strip server-assigned fields (\`resourceVersion\`, \`uid\`, \`creationTimestamp\`, \`status\`, and a Service's \`spec.clusterIP\`/\`clusterIPs\`). Apply them to the new namespace.`,
    `4. Verify the new deployment's pods come up healthy in \`${targetNamespace}\`.`,
    `5. Only then delete the originals from \`${src}\`.`,
    ``,
    `## Important`,
    `- **PVCs: the data does NOT follow.** A recreated PVC binds to a new, empty volume. STOP and explain this before touching any PVC — confirm whether to recreate empty, skip storage, or manually rebind the existing PV. Do not delete the source PVC unless I explicitly agree.`,
    `- Anything still referencing \`${src}/${name}\` (or its Services) by namespace will break until updated — call out anything you can't see.`,
    `- Surface the discovery first, then propose the apply/delete actions; don't bulk-delete before the new namespace is confirmed working.`,
  ].join("\n");
}

/**
 * Build the investigation prompt for a single Recent-warning event. Unlike
 * buildHandoffPrompt (keyed by kind/name/topic), this consumes a K8sEvent so it
 * can fold in the warning's reason and message — a distinct purpose, not a
 * variation of the topic prompts.
 */
export function buildWarningInvestigationPrompt(event: K8sEvent): string {
  const io = event.involvedObject;
  const ns = io?.namespace ?? "default";
  const target =
    io?.kind && io?.name
      ? `${io.kind} ${io.name} in namespace ${ns}`
      : io?.name
        ? `${io.name} in namespace ${ns}`
        : `a resource in namespace ${ns}`;
  const reason = event.reason ?? "Warning";
  const parts = [
    `Investigate this Kubernetes warning.`,
    `Reason: ${reason}. Resource: ${target}.`,
  ];
  if (event.message) parts.push(`Message: "${event.message}".`);
  parts.push(`Find the root cause and suggest a fix. Use read-only kubectl. Be concise.`);
  return parts.join(" ");
}
