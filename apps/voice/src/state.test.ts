import { describe, expect, test } from "vitest";
import { buildKeyterms, STATIC_KEYTERMS } from "./keyterms.js";
import { DESKTOP_IDENTITY, applyDataFrame, emptySessionState } from "./state.js";

describe("emptySessionState", () => {
  test("starts with no context and no pending mutation", () => {
    expect(emptySessionState()).toEqual({
      activeContext: null,
      contextLines: [],
      pending: null,
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
    expect(effect).toEqual({ contextChanged: false, keytermsChanged: true });
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
    expect(effect).toEqual({ contextChanged: false, keytermsChanged: false });
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
