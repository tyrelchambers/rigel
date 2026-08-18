import { describe, expect, test } from "vitest";
import type { MentionCandidate, MentionKind } from "@/panels/chat/mentions";
import { MAX_VOICE_KEYTERMS, voiceKeytermNames } from "./keyterms";

function candidate(kind: MentionKind, name: string): MentionCandidate {
  return { id: `${kind}-${name}`, kind, name, context: "" };
}

describe("voiceKeytermNames", () => {
  test("deployments come first, then nodes, then pods", () => {
    const names = voiceKeytermNames([
      candidate("pod", "web-7f9b64c8d-x2x4p"),
      candidate("node", "worker-1"),
      candidate("deployment", "web"),
    ]);
    expect(names).toEqual(["web", "worker-1", "web-7f9b64c8d-x2x4p"]);
  });

  test("candidates of one kind keep the order the store gave them", () => {
    const names = voiceKeytermNames([candidate("deployment", "b"), candidate("deployment", "a")]);
    expect(names).toEqual(["b", "a"]);
  });

  test("the same name across namespaces takes one slot", () => {
    const names = voiceKeytermNames([
      candidate("deployment", "web"),
      { ...candidate("deployment", "web"), id: "dep-other", namespace: "staging" },
    ]);
    expect(names).toEqual(["web"]);
  });

  test("blank names are dropped", () => {
    expect(voiceKeytermNames([candidate("deployment", "  ")])).toEqual([]);
  });

  test("the list is capped, and deployments outrank pods for the last slots", () => {
    const deployments = Array.from({ length: MAX_VOICE_KEYTERMS }, (_, i) => candidate("deployment", `svc-${i}`));
    const names = voiceKeytermNames([candidate("pod", "noisy-pod"), ...deployments]);
    expect(names).toHaveLength(MAX_VOICE_KEYTERMS);
    expect(names).not.toContain("noisy-pod");
  });

  test("no candidates yields no names", () => {
    expect(voiceKeytermNames([])).toEqual([]);
  });
});
