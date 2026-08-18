import { describe, expect, test } from "vitest";
import { DESKTOP_IDENTITY, applyDataFrame, emptySessionState } from "./state.js";

describe("emptySessionState", () => {
  test("starts with no context and no pending mutation", () => {
    expect(emptySessionState()).toEqual({ activeContext: null, contextLines: [], pending: null });
  });
});

describe("applyDataFrame", () => {
  test("rigel.state from the desktop sets activeContext and reports the change", () => {
    const state = emptySessionState();
    const changed = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", JSON.stringify({ activeContext: "prod" }));
    expect(state.activeContext).toBe("prod");
    expect(changed).toBe(true);
  });

  test("a rigel.state repeating the context it already holds reports no change", () => {
    const state = { ...emptySessionState(), activeContext: "prod" };
    const changed = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", JSON.stringify({ activeContext: "prod" }));
    expect(changed).toBe(false);
  });

  test("a rigel.context frame never reports a context change", () => {
    const state = emptySessionState();
    const changed = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.context", JSON.stringify({ context: "deployment/web" }));
    expect(changed).toBe(false);
  });

  test("rigel.state from the desktop can clear activeContext to null", () => {
    const state = { ...emptySessionState(), activeContext: "prod" };
    const changed = applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", JSON.stringify({ activeContext: null }));
    expect(state.activeContext).toBeNull();
    expect(changed).toBe(true);
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
});
