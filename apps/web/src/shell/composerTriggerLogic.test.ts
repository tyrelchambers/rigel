import { describe, it, expect } from "vitest";
import {
  computeTrigger,
  commandRest,
  describeInsertion,
  type ComposerTrigger,
  type ComposerTriggerContext,
} from "./composerTriggerLogic";
import type { MentionCandidate } from "@/panels/chat/mentions";

type DescribeTrigger = Extract<ComposerTrigger, { kind: "describe" }>;

const MENTIONS: MentionCandidate[] = [
  { id: "dep-web", kind: "deployment", name: "web", namespace: "default", context: "Deployment web" },
  { id: "pod-web-abc", kind: "pod", name: "web-abc", namespace: "default", context: "Pod web-abc" },
  { id: "node-n1", kind: "node", name: "node1", context: "Node node1" },
];

// A store snapshot with a couple of namespaces and resources for describe tests.
const RESOURCES: Record<string, unknown> = {
  namespaces: {
    default: { metadata: { name: "default" } },
    "kube-system": { metadata: { name: "kube-system" } },
  },
  ingresses: {
    "default/web": { metadata: { name: "web-ing", namespace: "default" } },
    "kube-system/dash": { metadata: { name: "dashboard", namespace: "kube-system" } },
  },
  nodes: {
    n1: { metadata: { name: "k8s-truenas" } },
    n2: { metadata: { name: "k8s-rpi" } },
  },
};

function ctx(overrides: Partial<ComposerTriggerContext> = {}): ComposerTriggerContext {
  return { mentionCandidates: MENTIONS, resources: {}, namespaceFilter: null, ...overrides };
}

describe("computeTrigger — command + mention (existing behavior)", () => {
  it("matches a leading / command trigger", () => {
    const t = computeTrigger("/log", 4, ctx());
    expect(t?.kind).toBe("command");
    if (t?.kind === "command") {
      expect(t.query).toBe("log");
      expect(t.items.some((c) => c.name === "logs")).toBe(true);
    }
  });

  it("returns all commands for a bare slash", () => {
    const t = computeTrigger("/", 1, ctx());
    expect(t?.kind).toBe("command");
  });

  it("matches a mid-text @ mention trigger", () => {
    const value = "restart @web";
    const t = computeTrigger(value, value.length, ctx());
    expect(t?.kind).toBe("mention");
    if (t?.kind === "mention") {
      expect(t.query).toBe("web");
      expect(t.start).toBe(8);
    }
  });

  it("does not trigger a command when whitespace precedes the caret", () => {
    expect(computeTrigger("/logs web", 9, ctx())).toBeNull();
  });

  it("returns null when nothing matches (plain text)", () => {
    expect(computeTrigger("hello world", 11, ctx())).toBeNull();
  });
});

describe("computeTrigger — /describe type stage", () => {
  it("lists all curated types right after '/describe '", () => {
    const v = "/describe ";
    const t = computeTrigger(v, v.length, ctx());
    expect(t?.kind).toBe("describe");
    if (t?.kind === "describe") {
      expect(t.stage).toBe("type");
      expect(t.items.some((o) => o.value === "ingress")).toBe(true);
      expect(t.items.some((o) => o.value === "node")).toBe(true);
    }
  });

  it("filters types by the partial", () => {
    const v = "/describe ing";
    const t = computeTrigger(v, v.length, ctx());
    expect(t?.kind).toBe("describe");
    if (t?.kind === "describe") {
      expect(t.stage).toBe("type");
      expect(t.query).toBe("ing");
      expect(t.start).toBe("/describe ".length);
      expect(t.items[0]?.value).toBe("ingress");
    }
  });

  it("returns null for a type that isn't curated (falls through to the agent)", () => {
    const v = "/describe widget ";
    expect(computeTrigger(v, v.length, ctx())).toBeNull();
  });
});

describe("computeTrigger — /describe namespace stage", () => {
  it("requires a namespace first for a namespaced kind when filter is All", () => {
    const v = "/describe ingress ";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES, namespaceFilter: null }));
    expect(t?.kind).toBe("describe");
    if (t?.kind === "describe") {
      expect(t.stage).toBe("namespace");
      expect(t.items.map((o) => o.value)).toContain("default");
      expect(t.items.map((o) => o.value)).toContain("kube-system");
    }
  });

  it("filters namespaces by the partial", () => {
    const v = "/describe ingress kube";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES }));
    if (t?.kind === "describe") {
      expect(t.stage).toBe("namespace");
      expect(t.items.map((o) => o.value)).toEqual(["kube-system"]);
    }
  });
});

describe("computeTrigger — /describe instance stage", () => {
  it("skips the namespace step when a specific filter is active", () => {
    const v = "/describe ingress ";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES, namespaceFilter: "default" }));
    expect(t?.kind).toBe("describe");
    if (t?.kind === "describe") {
      expect(t.stage).toBe("instance");
      expect(t.namespace).toBe("default");
      expect(t.items.map((o) => o.value)).toEqual(["web-ing"]);
    }
  });

  it("resolves the namespace from an explicit -n flag", () => {
    const v = "/describe ingress -n kube-system ";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES, namespaceFilter: null }));
    if (t?.kind === "describe") {
      expect(t.stage).toBe("instance");
      expect(t.namespace).toBe("kube-system");
      expect(t.items.map((o) => o.value)).toEqual(["dashboard"]);
    }
  });

  it("goes straight to instances for a cluster-scoped kind (no namespace)", () => {
    const v = "/describe node ";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES, namespaceFilter: null }));
    if (t?.kind === "describe") {
      expect(t.stage).toBe("instance");
      expect(t.namespace).toBeUndefined();
      expect(t.items.map((o) => o.value).sort()).toEqual(["k8s-rpi", "k8s-truenas"]);
    }
  });

  it("filters instances by the name partial", () => {
    const v = "/describe node truen";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES }));
    if (t?.kind === "describe") {
      expect(t.stage).toBe("instance");
      expect(t.items.map((o) => o.value)).toEqual(["k8s-truenas"]);
    }
  });

  it("returns an empty instance list (popover shows a no-results state)", () => {
    const v = "/describe pod -n default ";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES }));
    expect(t?.kind).toBe("describe");
    if (t?.kind === "describe") {
      expect(t.stage).toBe("instance");
      expect(t.items).toEqual([]);
    }
  });
});

describe("describeInsertion — canonical command building", () => {
  it("type stage inserts '/describe <type> '", () => {
    const v = "/describe ing";
    const t = computeTrigger(v, v.length, ctx()) as DescribeTrigger;
    const opt = t.items.find((o) => o.value === "ingress")!;
    expect(describeInsertion(t, opt)).toBe("/describe ingress ");
  });

  it("namespace stage inserts '/describe <type> -n <ns> '", () => {
    const v = "/describe ingress ";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES })) as DescribeTrigger;
    const opt = t.items.find((o) => o.value === "default")!;
    expect(describeInsertion(t, opt)).toBe("/describe ingress -n default ");
  });

  it("instance stage (namespaced) produces the full command, same regardless of path", () => {
    // via explicit -n in the text
    const a = "/describe ingress -n default ";
    const ta = computeTrigger(a, a.length, ctx({ resources: RESOURCES })) as DescribeTrigger;
    expect(describeInsertion(ta, ta.items[0]!)).toBe("/describe ingress web-ing -n default");

    // via the active filter (no -n in text) — identical canonical output
    const b = "/describe ingress ";
    const tb = computeTrigger(b, b.length, ctx({ resources: RESOURCES, namespaceFilter: "default" })) as DescribeTrigger;
    expect(describeInsertion(tb, tb.items[0]!)).toBe("/describe ingress web-ing -n default");
  });

  it("instance stage (cluster-scoped) omits -n", () => {
    const v = "/describe node truen";
    const t = computeTrigger(v, v.length, ctx({ resources: RESOURCES })) as DescribeTrigger;
    expect(describeInsertion(t, t.items[0]!)).toBe("/describe node k8s-truenas");
  });
});

describe("commandRest", () => {
  it("returns the text after the first space", () => {
    expect(commandRest("/logs web")).toBe("web");
  });
  it("returns empty string when there is no space", () => {
    expect(commandRest("/logs")).toBe("");
  });
});
