import { describe, it, expect } from "vitest";
import { extractActionBlocks, stripActionBlocks, parseSuggestedActions } from "@/lib/actionBlocks";

describe("extractActionBlocks", () => {
  it("extracts a single action block", () => {
    const md =
      'Here is what I recommend:\n\n```action\n{"label":"Restart","kind":"restart","name":"web","namespace":"default"}\n```';
    const actions = extractActionBlocks(md);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      label: "Restart",
      kind: "restart",
      name: "web",
      namespace: "default",
    });
  });

  it("extracts multiple action blocks", () => {
    const md =
      '```action\n{"label":"Restart web","kind":"restart","name":"web"}\n```\n\n' +
      'text in between\n\n' +
      '```action\n{"label":"Scale web","kind":"scale","name":"web","replicas":3}\n```';
    const actions = extractActionBlocks(md);
    expect(actions).toHaveLength(2);
    expect(actions[0].kind).toBe("restart");
    expect(actions[1].kind).toBe("scale");
    expect(actions[1].replicas).toBe(3);
  });

  it("skips malformed JSON", () => {
    const md = "```action\n{not valid json}\n```";
    expect(extractActionBlocks(md)).toHaveLength(0);
  });

  it("skips blocks missing required label/kind", () => {
    const md = '```action\n{"name":"web"}\n```';
    expect(extractActionBlocks(md)).toHaveLength(0);
  });

  it("ignores non-action code fences", () => {
    const md = "```bash\nkubectl get pods\n```";
    expect(extractActionBlocks(md)).toHaveLength(0);
  });

  it("extracts one valid block and skips an adjacent malformed one", () => {
    const md =
      '```action\n{bad}\n```\n```action\n{"label":"Drain","kind":"drain","node":"n1"}\n```';
    const actions = extractActionBlocks(md);
    expect(actions).toHaveLength(1);
    expect(actions[0].node).toBe("n1");
  });
});

describe("stripActionBlocks", () => {
  it("removes action blocks from display text", () => {
    const md = 'Doing it.\n\n```action\n{"label":"x","kind":"restart"}\n```\n\nDone.';
    const display = stripActionBlocks(md);
    expect(display).not.toContain("```action");
    expect(display).toContain("Doing it.");
    expect(display).toContain("Done.");
  });

  it("removes question blocks but preserves other code fences", () => {
    const md =
      '```bash\necho hello\n```\n\n```question\n{"q":"which?"}\n```\n\n' +
      '```action\n{"label":"x","kind":"restart"}\n```';
    const display = stripActionBlocks(md);
    expect(display).toContain("```bash");
    expect(display).toContain("echo hello");
    expect(display).not.toContain("```action");
    expect(display).not.toContain("```question");
  });
});

describe("parseSuggestedActions", () => {
  it("returns display and actions together", () => {
    const md = 'Prose.\n\n```action\n{"label":"Restart","kind":"restart","name":"web"}\n```';
    const { display, actions } = parseSuggestedActions(md);
    expect(display).toBe("Prose.");
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe("Restart");
  });
});
