import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerChatHandoff, registerChatReveal, handoffToChat } from "./chatHandoff";

beforeEach(() => {
  // Reset module-global registrations between tests.
  registerChatHandoff(() => {});
  registerChatReveal(() => {});
});

describe("handoffToChat", () => {
  it("forwards the prompt and options to the registered handler", () => {
    const send = vi.fn();
    registerChatHandoff(send);
    handoffToChat("hello", { newThread: true });
    expect(send).toHaveBeenCalledWith("hello", { newThread: true });
  });

  it("calls the reveal hook when newThread is set", () => {
    const reveal = vi.fn();
    registerChatReveal(reveal);
    handoffToChat("hello", { newThread: true });
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("does NOT reveal for a plain handoff", () => {
    const reveal = vi.fn();
    registerChatReveal(reveal);
    handoffToChat("hello");
    expect(reveal).not.toHaveBeenCalled();
  });
});
