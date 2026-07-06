import { describe, expect, it } from "vitest";
import { conjugateDone, couldntPhrase, greeting } from "./notifyVoice.js";

describe("conjugateDone", () => {
  it("past-tenses a single-word verb off the kind", () => {
    expect(conjugateDone("restart", "Restart backend-worker so Celery recovers")).toBe(
      "Restarted backend-worker so Celery recovers",
    );
    expect(conjugateDone("scale", "Scale backend-worker to 3")).toBe("Scaled backend-worker to 3");
    expect(conjugateDone("deletePod", "Delete the stuck pod")).toBe("Deleted the stuck pod");
  });

  it("past-tenses a two-word verb (rollback)", () => {
    expect(conjugateDone("rollback", "Roll back backend-worker to the last stable revision")).toBe(
      "Rolled back backend-worker to the last stable revision",
    );
  });

  it("matches case-insensitively", () => {
    expect(conjugateDone("restart", "restart the worker")).toBe("Restarted the worker");
  });

  it("leaves the label unchanged when it doesn't start with the expected verb", () => {
    expect(conjugateDone("restart", "Bounce the worker")).toBe("Bounce the worker");
    expect(conjugateDone("restart", "Restarting the worker")).toBe("Restarting the worker");
  });

  it("leaves the label unchanged for an unknown kind", () => {
    expect(conjugateDone("mystery", "Do the thing")).toBe("Do the thing");
  });
});

describe("couldntPhrase", () => {
  it("lowercases the first word after Couldn't", () => {
    expect(couldntPhrase("Restart backend-worker")).toBe("Couldn't restart backend-worker");
  });
});

describe("greeting", () => {
  it("success-only", () => {
    expect(greeting(["✓ Restarted x", "✓ Scaled y"])).toBe("Here's what I took care of:");
  });

  it("failure-only", () => {
    expect(greeting(["✗ Couldn't restart y"])).toBe("Ran into a snag on this one:");
    expect(greeting(["✗ a", "✗ b"])).toBe("Ran into a couple snags:");
  });

  it("success and failure, no pending", () => {
    expect(greeting(["✓ Restarted x", "✗ Couldn't restart y"])).toBe("Here's what I've been up to:");
  });

  it("one pending", () => {
    expect(greeting(["▸ I'd like to roll back x"])).toBe("One thing I'd like to run past you:");
  });

  it("multiple pending", () => {
    expect(greeting(["▸ a", "▸ b"])).toBe("A couple things I'd like to run past you:");
  });

  it("mixed done and pending", () => {
    expect(greeting(["✓ done", "▸ pending"])).toBe(
      "Here's what I handled, plus a couple things I'd like your OK on:",
    );
  });

  it("falls back to a neutral line for other producers", () => {
    expect(greeting(["Digest: 3 pods restarted overnight"])).toBe("Quick update from the cluster:");
  });
});
