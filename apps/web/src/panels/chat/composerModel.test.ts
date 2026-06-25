// @vitest-environment jsdom
//
// Agent-aware composer model selection: pretty labels, per-agent persistence
// (with v1→v2 migration), and resolution of the active selection against an
// agent's currently-advertised models/efforts.
import { describe, it, expect, beforeEach } from "vitest";
import {
  modelLabel,
  modelName,
  loadModelConfigs,
  saveModelConfig,
  resolveModelConfig,
} from "./composerModel";

const V2_KEY = "rigel.modelConfig.v2";
const LEGACY_KEY = "rigel.chat.modelConfig";

beforeEach(() => {
  localStorage.clear();
});

describe("modelLabel / modelName", () => {
  it("pretty-prints Claude model ids and shows the raw id for other agents", () => {
    expect(modelLabel("claude", "claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelLabel("claude", "claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(modelLabel("claude", "claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("claude", "claude-fable-5")).toBe("Fable 5");
    // Unknown Claude id falls back to the raw id.
    expect(modelLabel("claude", "weird")).toBe("weird");
    // Other agents always show the raw id.
    expect(modelLabel("codex", "gpt-5-codex")).toBe("gpt-5-codex");
    expect(modelName("opencode", "anthropic/claude-sonnet-4-6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });
});

describe("per-agent persistence", () => {
  it("saves + loads a selection keyed by agentId", () => {
    saveModelConfig("claude", { model: "claude-sonnet-4-6", effort: "low" });
    saveModelConfig("codex", { model: "gpt-5" });

    const map = loadModelConfigs();
    expect(map.claude).toEqual({ model: "claude-sonnet-4-6", effort: "low" });
    expect(map.codex).toEqual({ model: "gpt-5" });
  });

  it("merges new saves into the existing map without clobbering other agents", () => {
    saveModelConfig("claude", { model: "claude-opus-4-8", effort: "high" });
    saveModelConfig("opencode", { model: "openai/gpt-5" });
    saveModelConfig("claude", { model: "claude-haiku-4-5-20251001", effort: "max" });

    const map = loadModelConfigs();
    expect(map.claude).toEqual({ model: "claude-haiku-4-5-20251001", effort: "max" });
    expect(map.opencode).toEqual({ model: "openai/gpt-5" });
  });

  it("migrates a legacy v1 global config into the claude slot, then removes it", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ model: "sonnet", effort: "medium" }));

    const map = loadModelConfigs();
    expect(map.claude).toEqual({ model: "sonnet", effort: "medium" });
    // Legacy key is cleared and the v2 key is written.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(V2_KEY)).not.toBeNull();
  });

  it("ignores malformed entries", () => {
    localStorage.setItem(V2_KEY, JSON.stringify({ claude: { model: "opus" }, codex: 5 }));
    const map = loadModelConfigs();
    expect(map.claude).toEqual({ model: "opus" });
    expect(map.codex).toBeUndefined();
  });
});

describe("resolveModelConfig", () => {
  const claudeModels = [
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-fable-5",
  ];
  const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];

  it("returns null while the model list is unknown/empty", () => {
    expect(resolveModelConfig("claude", undefined, [], [])).toBeNull();
  });

  it("keeps the stored model + effort when both are still valid (Claude)", () => {
    const stored = { model: "claude-sonnet-4-6", effort: "low" };
    expect(resolveModelConfig("claude", stored, claudeModels, claudeEfforts)).toEqual({
      model: "claude-sonnet-4-6",
      effort: "low",
    });
  });

  it("defaults Claude to claude-opus-4-8/high when nothing is stored", () => {
    expect(resolveModelConfig("claude", undefined, claudeModels, claudeEfforts)).toEqual({
      model: "claude-opus-4-8",
      effort: "high",
    });
  });

  it("falls back to the first model when the stored model is gone", () => {
    const stored = { model: "removed", effort: "low" };
    const out = resolveModelConfig("codex", stored, ["gpt-5-codex", "gpt-5"], []);
    expect(out).toEqual({ model: "gpt-5-codex" });
  });

  it("omits effort entirely for agents with no efforts (Codex/OpenCode)", () => {
    const out = resolveModelConfig("opencode", undefined, ["anthropic/claude-opus-4-1"], []);
    expect(out).toEqual({ model: "anthropic/claude-opus-4-1" });
    expect("effort" in out!).toBe(false);
  });
});
