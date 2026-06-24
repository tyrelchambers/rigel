import { test, expect, describe } from "vitest";
import { agentModels, parseOpencodeModels } from "./agentModels";

// ---------------------------------------------------------------------------
// parseOpencodeModels — pure parser (no spawn; `opencode models` only lists)
// ---------------------------------------------------------------------------
describe("parseOpencodeModels", () => {
  test("keeps provider/model lines, drops blanks + junk, dedupes + sorts", () => {
    const stdout = [
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
      "", // blank
      "  ", // whitespace-only
      "Available models:", // header with a space → dropped
      "anthropic/claude-sonnet-4", // duplicate
      "vendor/some/model", // two slashes → dropped
      "noslash", // no slash → dropped
      "provider/ ", // trailing space → has whitespace → dropped
      "google/gemini-2.5-pro",
    ].join("\n");
    expect(parseOpencodeModels(stdout)).toEqual([
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-pro",
      "openai/gpt-5",
    ]);
  });

  test("empty / whitespace-only stdout → empty array", () => {
    expect(parseOpencodeModels("")).toEqual([]);
    expect(parseOpencodeModels("\n  \n\t\n")).toEqual([]);
  });

  test("trims surrounding whitespace on otherwise-valid lines", () => {
    expect(parseOpencodeModels("  anthropic/claude-opus-4  \n")).toEqual([
      "anthropic/claude-opus-4",
    ]);
  });
});

// ---------------------------------------------------------------------------
// agentModels — static sets for claude/codex; unknown → empty
// (opencode goes through a live spawn, so we don't exercise it here)
// ---------------------------------------------------------------------------
describe("agentModels", () => {
  test("claude → the full Claude model ids + the five effort levels", async () => {
    const r = await agentModels("claude");
    expect(r.models).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-fable-5",
    ]);
    expect(r.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("codex → the curated codex model set, no efforts", async () => {
    const r = await agentModels("codex");
    expect(r.models).toEqual(["gpt-5-codex", "gpt-5.4", "gpt-5"]);
    expect(r.efforts).toEqual([]);
  });

  test("gemini → the curated gemini model set, no efforts", async () => {
    const r = await agentModels("gemini");
    expect(r.models).toEqual(["gemini-3-pro", "gemini-3-flash", "gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(r.efforts).toEqual([]);
  });

  test("unknown id → empty models + efforts", async () => {
    // Cast: agentModels takes AgentId, but the route validates first; this proves
    // the defensive default branch returns empty rather than throwing.
    const r = await agentModels("bogus" as never);
    expect(r).toEqual({ models: [], efforts: [] });
  });
});
