// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/lib/desktop", () => ({ rigel: { platform: "darwin" } }));
import { useCommand, useShortcutDispatch, allowsInput } from "./useCommand";
import { COMMAND_BY_ID } from "./registry";
import { useShortcutStore } from "@/store/shortcuts";

function Dispatcher() {
  useShortcutDispatch();
  return null;
}

function Consumer({ id, fn, enabled = true }: { id: Parameters<typeof useCommand>[0]; fn: () => void; enabled?: boolean }) {
  useCommand(id, fn, enabled);
  return null;
}

function press(init: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; target?: HTMLElement }): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key: init.key,
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  (init.target ?? document.body).dispatchEvent(e);
  return e;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useShortcutStore.setState({ overrides: {} });
});

describe("useShortcutDispatch", () => {
  it("runs the registered handler and prevents the default", () => {
    const fn = vi.fn();
    render(<><Dispatcher /><Consumer id="chat.toggle" fn={fn} /></>);
    const e = press({ key: "j", code: "KeyJ", metaKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves the event alone when nothing claims the command", () => {
    render(<Dispatcher />);
    const e = press({ key: "j", code: "KeyJ", metaKey: true });
    expect(e.defaultPrevented).toBe(false);
  });

  it("prefers the most recently mounted handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<><Dispatcher /><Consumer id="chat.toggle" fn={first} /><Consumer id="chat.toggle" fn={second} /></>);
    press({ key: "j", code: "KeyJ", metaKey: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("stops dispatching once the consumer unmounts", () => {
    const fn = vi.fn();
    const { rerender } = render(<><Dispatcher /><Consumer id="chat.toggle" fn={fn} /></>);
    rerender(<Dispatcher />);
    const e = press({ key: "j", code: "KeyJ", metaKey: true });
    expect(fn).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("does not register while disabled", () => {
    const fn = vi.fn();
    render(<><Dispatcher /><Consumer id="voice.toggle" fn={fn} enabled={false} /></>);
    press({ key: "v", code: "KeyV", metaKey: true, altKey: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("honours a user override", () => {
    const fn = vi.fn();
    useShortcutStore.setState({ overrides: { "chat.toggle": { mod: true, key: "M" } } });
    render(<><Dispatcher /><Consumer id="chat.toggle" fn={fn} /></>);
    press({ key: "j", code: "KeyJ", metaKey: true });
    expect(fn).not.toHaveBeenCalled();
    press({ key: "m", code: "KeyM", metaKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still fires a modifier binding while focus is in a text field", () => {
    const fn = vi.fn();
    render(<><Dispatcher /><Consumer id="palette.open" fn={fn} /></>);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "k", code: "KeyK", metaKey: true, target: input });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("blocks a nav-history binding while focus is in a text field", () => {
    const fn = vi.fn();
    render(<><Dispatcher /><Consumer id="nav.back" fn={fn} /></>);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "ArrowLeft", metaKey: true, target: input });
    expect(fn).not.toHaveBeenCalled();
  });

  it("blocks a modifier-less rebind while focus is in a text field", () => {
    const fn = vi.fn();
    useShortcutStore.setState({ overrides: { "chat.toggle": { key: "F2" } } });
    render(<><Dispatcher /><Consumer id="chat.toggle" fn={fn} /></>);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "F2", target: input });
    expect(fn).not.toHaveBeenCalled();
    press({ key: "F2" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("allowsInput", () => {
  it("is false for a command marked block", () => {
    expect(allowsInput(COMMAND_BY_ID.get("nav.back")!, { mod: true, key: "[" })).toBe(false);
  });

  it("is false for a shift-only binding", () => {
    expect(allowsInput(COMMAND_BY_ID.get("chat.toggle")!, { shift: true, key: "J" })).toBe(false);
  });

  it("is true for a modifier binding", () => {
    expect(allowsInput(COMMAND_BY_ID.get("chat.toggle")!, { mod: true, key: "J" })).toBe(true);
  });
});
