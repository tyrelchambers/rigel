// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/desktop", () => ({ rigel: { platform: "darwin" } }));

import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyboardTab } from "./tabs/KeyboardTab";
import { useCommand, useShortcutDispatch } from "@/lib/shortcuts/useCommand";
import { useShortcutStore } from "@/store/shortcuts";

function Dispatcher() {
  useShortcutDispatch();
  return null;
}

function PaletteConsumer({ fn }: { fn: () => void }) {
  useCommand("palette.open", fn);
  return null;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useShortcutStore.setState({ overrides: {} });
});

describe("KeyboardTab", () => {
  it("lists every command with its default binding", () => {
    render(<KeyboardTab />);
    expect(screen.getByText("Open the command palette")).toBeTruthy();
    expect(screen.getByText("Start or end a voice session")).toBeTruthy();
    expect(screen.getAllByText("⌘K").length).toBeGreaterThan(0);
  });

  it("records a new binding", async () => {
    const user = userEvent.setup();
    render(<KeyboardTab />);
    await user.click(screen.getByRole("button", { name: "Record Show or hide the chat pane" }));
    fireEvent.keyDown(window, { key: "m", code: "KeyM", metaKey: true });
    expect(useShortcutStore.getState().overrides["chat.toggle"]).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: "M",
    });
  });

  it("refuses a combination another command already holds", async () => {
    const user = userEvent.setup();
    render(<KeyboardTab />);
    await user.click(screen.getByRole("button", { name: "Record Start or end a voice session" }));
    fireEvent.keyDown(window, { key: "j", code: "KeyJ", metaKey: true });
    expect(useShortcutStore.getState().overrides["voice.toggle"]).toBeUndefined();
    expect(screen.getByText(/already Show or hide the chat pane/)).toBeTruthy();
  });

  it("cancels recording on Escape", async () => {
    const user = userEvent.setup();
    render(<KeyboardTab />);
    await user.click(screen.getByRole("button", { name: "Record Show or hide the chat pane" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "m", code: "KeyM", metaKey: true });
    expect(useShortcutStore.getState().overrides["chat.toggle"]).toBeUndefined();
  });

  it("warns about a binding that will be inert in text fields", async () => {
    const user = userEvent.setup();
    render(<KeyboardTab />);
    await user.click(screen.getByRole("button", { name: "Record Show or hide the chat pane" }));
    fireEvent.keyDown(window, { key: "F2", code: "F2" });
    expect(useShortcutStore.getState().overrides["chat.toggle"]).toEqual({
      mod: false,
      ctrl: false,
      alt: false,
      shift: false,
      key: "F2",
    });
    expect(screen.getByText(/will not fire while you are typing/)).toBeTruthy();
  });

  it("does not fire the command it is recording over", async () => {
    const user = userEvent.setup();
    const fired = vi.fn();
    render(
      <>
        <Dispatcher />
        <PaletteConsumer fn={fired} />
        <KeyboardTab />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Record Start or end a voice session" }));
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    expect(fired).not.toHaveBeenCalled();
    expect(screen.getByText(/already Open the command palette/)).toBeTruthy();
  });

  it("resets one row back to its default", async () => {
    const user = userEvent.setup();
    useShortcutStore.setState({ overrides: { "chat.toggle": { mod: true, key: "M" } } });
    render(<KeyboardTab />);
    await user.click(screen.getByRole("button", { name: "Reset Show or hide the chat pane" }));
    expect("chat.toggle" in useShortcutStore.getState().overrides).toBe(false);
  });

  it("resets everything", async () => {
    const user = userEvent.setup();
    useShortcutStore.setState({
      overrides: { "chat.toggle": { mod: true, key: "M" }, "nav.back": null },
    });
    render(<KeyboardTab />);
    await user.click(screen.getByRole("button", { name: "Reset all" }));
    expect(useShortcutStore.getState().overrides).toEqual({});
  });
});
