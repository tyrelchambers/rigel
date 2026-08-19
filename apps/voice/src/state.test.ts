import { describe, expect, test } from "vitest";
import { buildKeyterms, STATIC_KEYTERMS } from "./keyterms.js";
import { DESKTOP_IDENTITY, applyDataFrame, emptySessionState, resetSessionState } from "./state.js";

describe("emptySessionState", () => {
  test("starts with no context and no pending mutation", () => {
    expect(emptySessionState()).toEqual({
      activeContext: null,
      contextLines: [],
      pending: null,
      awaitingClick: new Map(),
      keyterms: STATIC_KEYTERMS,
    });
  });
});

describe("applyDataFrame", () => {
  test("rigel.state from the desktop sets activeContext and reports the change", () => {
    const state = emptySessionState();
    const changed = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", JSON.stringify({ activeContext: "prod" }));
    expect(state.activeContext).toBe("prod");
    expect(changed.contextChanged).toBe(true);
  });

  test("a rigel.state repeating the context it already holds reports no change", () => {
    const state = { ...emptySessionState(), activeContext: "prod" };
    const changed = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", JSON.stringify({ activeContext: "prod" }));
    expect(changed.contextChanged).toBe(false);
  });

  test("a rigel.context frame never reports a context change", () => {
    const state = emptySessionState();
    const changed = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.context", JSON.stringify({ context: "deployment/web" }));
    expect(changed.contextChanged).toBe(false);
  });

  test("rigel.state from the desktop can clear activeContext to null", () => {
    const state = { ...emptySessionState(), activeContext: "prod" };
    const changed = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", JSON.stringify({ activeContext: null }));
    expect(state.activeContext).toBeNull();
    expect(changed.contextChanged).toBe(true);
  });

  test("rigel.context from the desktop appends a context line", () => {
    const state = emptySessionState();
    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.context", JSON.stringify({ context: "deployment/web" }));
    expect(state.contextLines).toEqual(["deployment/web"]);
  });

  test("rigel.context does not duplicate an existing line", () => {
    const state = { ...emptySessionState(), contextLines: ["deployment/web"] };
    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.context", JSON.stringify({ context: "deployment/web" }));
    expect(state.contextLines).toEqual(["deployment/web"]);
  });

  test("a frame from a non-desktop identity leaves state unchanged", () => {
    const state = emptySessionState();
    applyDataFrame(state, "rigel-phone", "rigel.state", JSON.stringify({ activeContext: "prod" }));
    expect(state.activeContext).toBeNull();
    expect(state).toEqual(emptySessionState());
  });

  test("a frame with no identity (undefined participant) leaves state unchanged", () => {
    const state = emptySessionState();
    applyDataFrame(state, undefined, "rigel.state", JSON.stringify({ activeContext: "prod" }));
    expect(state).toEqual(emptySessionState());
  });

  test("malformed JSON is ignored", () => {
    const state = emptySessionState();
    expect(() => applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", "{not json")).not.toThrow();
    expect(state).toEqual(emptySessionState());
  });

  test("a rigel.state payload with the wrong shape is ignored", () => {
    const state = emptySessionState();
    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", JSON.stringify({ activeContext: 42 }));
    expect(state.activeContext).toBeNull();
  });

  test("an unknown topic is ignored", () => {
    const state = emptySessionState();
    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.other", JSON.stringify({ activeContext: "prod" }));
    expect(state).toEqual(emptySessionState());
  });

  test("rigel.keyterms from the desktop replaces the keyterms and reports the change", () => {
    const state = emptySessionState();
    const effect = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.keyterms", JSON.stringify({ names: ["web", "cert-manager"] }));
    expect(effect).toEqual({ contextChanged: false, keytermsChanged: true, speak: null });
    expect(state.keyterms).toEqual(buildKeyterms(["web", "cert-manager"]));
  });

  test("a rigel.keyterms frame repeating the current set reports no change", () => {
    const state = emptySessionState();
    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.keyterms", JSON.stringify({ names: ["web"] }));
    const effect = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.keyterms", JSON.stringify({ names: ["web"] }));
    expect(effect.keytermsChanged).toBe(false);
    expect(state.keyterms).toEqual(buildKeyterms(["web"]));
  });

  test("names that collapse to the same capped set report no change", () => {
    const state = emptySessionState();
    const first = Array.from({ length: 200 }, (_, i) => `svc-${i}`);
    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.keyterms", JSON.stringify({ names: first }));
    const effect = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.keyterms", JSON.stringify({ names: [...first, "svc-200"] }));
    expect(effect.keytermsChanged).toBe(false);
  });

  test("a rigel.keyterms frame from a non-desktop identity leaves the keyterms alone", () => {
    const state = emptySessionState();
    const effect = applyDataFrame(state, "rigel-phone", "rigel.keyterms", JSON.stringify({ names: ["evil"] }));
    expect(effect).toEqual({ contextChanged: false, keytermsChanged: false, speak: null });
    expect(state.keyterms).toEqual(STATIC_KEYTERMS);
  });

  test("a rigel.keyterms payload with the wrong shape is ignored", () => {
    const state = emptySessionState();
    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.keyterms", JSON.stringify({ names: "web" }));
    expect(state.keyterms).toEqual(STATIC_KEYTERMS);
  });

  test("non-string entries in rigel.keyterms are dropped", () => {
    const state = emptySessionState();
    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.keyterms", JSON.stringify({ names: ["web", 42, null] }));
    expect(state.keyterms).toEqual(buildKeyterms(["web"]));
  });
});

describe("rigel.action.result", () => {
  /** A click-tier proposal already sent to the desktop, as agent.ts records it. */
  function awaiting(id = "call-1", label = "Delete pod web-1") {
    const state = emptySessionState();
    state.awaitingClick.set(id, label);
    return state;
  }

  test("a successful desktop run gives the agent the line to speak and closes the slot", () => {
    const state = awaiting();
    const effect = applyDataFrame(
      state,
      DESKTOP_IDENTITY,
      "rigel.action.result",
      JSON.stringify({ id: "call-1", ok: true, summary: "ran" }),
    );
    expect(effect.speak).toBe("Done. Delete pod web-1 completed.");
    expect(state.awaitingClick.size).toBe(0);
  });

  test("a failed desktop run speaks the reason the desktop reported", () => {
    const effect = applyDataFrame(
      awaiting(),
      DESKTOP_IDENTITY,
      "rigel.action.result",
      JSON.stringify({ id: "call-1", ok: false, summary: 'Error from server (NotFound): pods "web-1" not found' }),
    );
    expect(effect.speak).toBe('That failed: Error from server (NotFound): pods "web-1" not found.');
  });

  test("a result carrying no summary still says something", () => {
    const effect = applyDataFrame(
      awaiting(),
      DESKTOP_IDENTITY,
      "rigel.action.result",
      JSON.stringify({ id: "call-1", ok: false }),
    );
    expect(effect.speak).toBe("That failed: unknown error.");
  });

  test("a result for an id this worker never sent to the desktop says nothing", () => {
    const effect = applyDataFrame(
      awaiting(),
      DESKTOP_IDENTITY,
      "rigel.action.result",
      JSON.stringify({ id: "call-99", ok: true, summary: "ran" }),
    );
    expect(effect.speak).toBeNull();
  });

  test("the same result arriving twice only speaks once", () => {
    const state = awaiting();
    const raw = JSON.stringify({ id: "call-1", ok: true, summary: "ran" });
    expect(applyDataFrame(state, DESKTOP_IDENTITY, "rigel.action.result", raw).speak).not.toBeNull();
    expect(applyDataFrame(state, DESKTOP_IDENTITY, "rigel.action.result", raw).speak).toBeNull();
  });

  test("a result from a phone cannot make the agent claim a change ran", () => {
    const state = awaiting();
    const effect = applyDataFrame(
      state,
      "rigel-phone-abc",
      "rigel.action.result",
      JSON.stringify({ id: "call-1", ok: true, summary: "ran" }),
    );
    expect(effect.speak).toBeNull();
    expect(state.awaitingClick.get("call-1")).toBe("Delete pod web-1");
  });

  test("ending a desktop session drops proposals the operator never answered", () => {
    const state = awaiting();
    resetSessionState(state);
    expect(state.awaitingClick.size).toBe(0);
  });
});
