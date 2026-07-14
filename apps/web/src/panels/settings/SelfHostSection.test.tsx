// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SelfHostSection } from "./SelfHostSection";

beforeEach(() => localStorage.clear());

describe("SelfHostSection — Cancel", () => {
  it("Cancel reverts edits to the last-saved defaults and is disabled when clean", () => {
    render(<SelfHostSection />);
    const cancel = screen.getByRole("button", { name: /^cancel$/i });
    expect(cancel).toBeDisabled(); // nothing edited yet

    const input = screen.getByPlaceholderText("apps.example.com") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "apps.mine.com" } });
    expect(cancel).toBeEnabled();

    fireEvent.click(cancel);
    expect((screen.getByPlaceholderText("apps.example.com") as HTMLInputElement).value).toBe("");
    expect(cancel).toBeDisabled();
  });

  it("after Save there are no unsaved edits, so Cancel is disabled", () => {
    render(<SelfHostSection />);
    const input = screen.getByPlaceholderText("apps.example.com") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "apps.saved.com" } });
    fireEvent.click(screen.getByRole("button", { name: /save defaults/i }));

    const cancel = screen.getByRole("button", { name: /^cancel$/i });
    expect(cancel).toBeDisabled();
    expect((screen.getByPlaceholderText("apps.example.com") as HTMLInputElement).value).toBe("apps.saved.com");
  });
});
