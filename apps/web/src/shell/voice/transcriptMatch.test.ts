import { describe, expect, test } from "vitest";
import { normalizeTranscript, matchTranscript } from "./transcriptMatch";
import type { MentionCandidate } from "@/panels/chat/mentions";

const c = (kind: MentionCandidate["kind"], name: string, id = `${kind}-${name}`): MentionCandidate => ({
  id,
  kind,
  name,
  namespace: "default",
  context: `${kind} ${name} summary`,
});

const CANDS: MentionCandidate[] = [
  c("deployment", "cert-manager"),
  c("deployment", "web"),
  c("pod", "web-7f9b64c8d-x2x4p"),
  c("node", "k3s-slave"),
];

const ids = (text: string, candidates = CANDS) => matchTranscript(text, candidates).map((m) => m.id);

describe("normalizeTranscript", () => {
  test("lowercases, maps spoken dash/hyphen, strips punctuation", () => {
    expect(normalizeTranscript("Restart Cert dash Manager, please!")).toBe("restart cert - manager please");
  });

  test("maps the spoken word hyphen the same way as dash", () => {
    expect(normalizeTranscript("cert hyphen manager")).toBe("cert - manager");
  });

  test("leaves dash inside a word alone", () => {
    expect(normalizeTranscript("dashboard is up")).toBe("dashboard is up");
  });

  test("drops both straight and curly apostrophes without splitting the word", () => {
    expect(normalizeTranscript("what's the node's state")).toBe("whats the nodes state");
    expect(normalizeTranscript("what’s up")).toBe("whats up");
  });
});

describe("matchTranscript", () => {
  test("hyphens spoken as pauses: spaced and squashed forms both match", () => {
    expect(ids("what's up with cert manager")).toEqual(["deployment-cert-manager"]);
    expect(ids("check certmanager")).toEqual(["deployment-cert-manager"]);
    expect(ids("cert dash manager is failing")).toEqual(["deployment-cert-manager"]);
    expect(ids("look at cert-manager")).toEqual(["deployment-cert-manager"]);
  });

  test("a pod hash suffix is stripped, but the exact deployment wins the window", () => {
    expect(ids("is web healthy")).toEqual(["deployment-web"]);
  });

  test("a base-name pod still matches when no deployment claims the window", () => {
    const pods = [c("pod", "redis-6d4cf56db6-hk29w")];
    expect(ids("restart redis", pods)).toEqual(["pod-redis-6d4cf56db6-hk29w"]);
    expect(ids("restart red is", pods)).toEqual(["pod-redis-6d4cf56db6-hk29w"]);
  });

  test("only generated segments are stripped, so a hyphenated base survives", () => {
    const pods = [c("pod", "cert-manager-7d9f8b6c5-q4nzt")];
    expect(ids("tail cert manager", pods)).toEqual(["pod-cert-manager-7d9f8b6c5-q4nzt"]);
  });

  test("at most two trailing generated segments come off", () => {
    const pods = [c("pod", "web-abc123-def456-ghi789")];
    expect(ids("look at web", pods)).toEqual([]);
    expect(ids("look at web abc123", pods)).toEqual(["pod-web-abc123-def456-ghi789"]);
  });

  test("the full pod name still pins the pod", () => {
    expect(ids("describe web-7f9b64c8d-x2x4p")).toContain("pod-web-7f9b64c8d-x2x4p");
  });

  test("nodes match", () => {
    expect(ids("cordon k3s slave")).toEqual(["node-k3s-slave"]);
  });

  test("windows under 3 characters never match", () => {
    const short = [c("deployment", "db")];
    expect(matchTranscript("db is fine", short)).toEqual([]);
  });

  test("no false positives on unrelated speech", () => {
    expect(matchTranscript("how is the cluster doing today", CANDS)).toEqual([]);
  });

  test("a name spoken as five words matches", () => {
    const five = [c("deployment", "one-two-three-four-five")];
    expect(ids("scale one two three four five", five)).toEqual(["deployment-one-two-three-four-five"]);
  });

  test("a name longer than the window resolves from its leading five segments", () => {
    const six = [c("deployment", "one-two-three-four-five-six")];
    expect(ids("scale one two three four five six", six)).toEqual(["deployment-one-two-three-four-five-six"]);
    expect(ids("scale one-two-three-four-five-six", six)).toEqual(["deployment-one-two-three-four-five-six"]);
  });

  test("a resource named twice is returned once", () => {
    expect(ids("restart cert manager then check cert manager again")).toEqual(["deployment-cert-manager"]);
  });

  test("several resources in one utterance all come back", () => {
    expect(ids("cordon k3s slave and restart certmanager")).toEqual([
      "node-k3s-slave",
      "deployment-cert-manager",
    ]);
  });

  test("a deployment outranks a node of the same name in the same window", () => {
    const same = [c("node", "gateway"), c("deployment", "gateway")];
    expect(ids("check gateway", same)).toEqual(["deployment-gateway", "node-gateway"]);
  });

  test("empty transcript and empty candidate list are both no-ops", () => {
    expect(matchTranscript("", CANDS)).toEqual([]);
    expect(matchTranscript("restart cert manager", [])).toEqual([]);
  });

  test("returns the candidate objects, so the context summary rides along", () => {
    expect(matchTranscript("check certmanager", CANDS)[0]?.context).toBe("deployment cert-manager summary");
  });
});

describe("segment-prefix matching", () => {
  const REDDEX: MentionCandidate[] = [
    c("deployment", "reddex-custom-website-deploy"),
    c("deployment", "reddex-deploy"),
  ];

  test("a bare prefix pins the least-padded candidate first, and keeps the runner-up", () => {
    expect(ids("how is reddex doing", REDDEX)).toEqual([
      "deployment-reddex-deploy",
      "deployment-reddex-custom-website-deploy",
    ]);
  });

  test("the full name spoken wins outright, with no ambiguous runner-up", () => {
    expect(ids("how is reddex deploy doing", REDDEX)).toEqual(["deployment-reddex-deploy"]);
    expect(ids("how is reddex-deploy doing", REDDEX)).toEqual(["deployment-reddex-deploy"]);
    expect(ids("restart reddex custom website deploy", REDDEX)).toEqual([
      "deployment-reddex-custom-website-deploy",
    ]);
  });

  test("a longer prefix suppresses the shorter one it contains", () => {
    expect(ids("check reddex custom", REDDEX)).toEqual(["deployment-reddex-custom-website-deploy"]);
  });

  test("a prefix that names nothing matches nothing", () => {
    expect(ids("how is grafana doing", REDDEX)).toEqual([]);
  });

  test("a prefix only matches on a whole segment boundary", () => {
    expect(ids("how is redd doing", REDDEX)).toEqual([]);
  });

  test("the three-character floor still holds for prefixes", () => {
    const short = [c("deployment", "db-writer"), c("deployment", "db-reader")];
    expect(ids("restart db", short)).toEqual([]);
  });

  test("a prefix shared by more of the cluster than a person would say is not a reference", () => {
    const many = [
      c("deployment", "rigel-api"),
      c("deployment", "rigel-web"),
      c("deployment", "rigel-agent"),
      c("deployment", "rigel-voice"),
    ];
    expect(ids("how is rigel doing", many)).toEqual([]);
    expect(ids("how is rigel doing", many.slice(0, 3))).toEqual([
      "deployment-rigel-agent",
      "deployment-rigel-api",
      "deployment-rigel-web",
    ]);
  });

  test("prefixes never outrank an exact name or a pod base name", () => {
    const mixed = [c("deployment", "web-frontend"), c("deployment", "web"), c("pod", "web-7f9b64c8d-x2x4p")];
    expect(ids("is web healthy", mixed)).toEqual(["deployment-web"]);
    const pods = [c("pod", "redis-6d4cf56db6-hk29w"), c("deployment", "redis-cache")];
    expect(ids("restart redis", pods)).toEqual(["pod-redis-6d4cf56db6-hk29w"]);
  });

  test("pod names are not prefix-indexed, so hash stripping keeps its limits", () => {
    const pods = [c("pod", "web-abc123-def456-ghi789")];
    expect(ids("look at web", pods)).toEqual([]);
  });

  test("nodes prefix-match too", () => {
    const nodes = [c("node", "k3s-slave-two")];
    expect(ids("cordon k3s slave", nodes)).toEqual(["node-k3s-slave-two"]);
  });
});
