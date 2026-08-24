// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResourceRefLink } from "./ResourceRefLink";

describe("ResourceRefLink", () => {
  it("renders a dim dash placeholder when the resource is null", () => {
    const onGoTo = vi.fn();
    render(<ResourceRefLink resource={null} onGoTo={onGoTo} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders plain text, not a button, when the resource has no uid", () => {
    const onGoTo = vi.fn();
    render(<ResourceRefLink resource={{ name: "site-tls" }} onGoTo={onGoTo} />);
    const text = screen.getByText("site-tls");
    expect(text.tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.click(text);
    expect(onGoTo).not.toHaveBeenCalled();
  });

  it("renders a clickable button that calls onGoTo when the resource has a uid", () => {
    const onGoTo = vi.fn();
    render(<ResourceRefLink resource={{ name: "site-tls", uid: "abc" }} onGoTo={onGoTo} />);
    const button = screen.getByRole("button", { name: "site-tls" });
    fireEvent.click(button);
    expect(onGoTo).toHaveBeenCalledTimes(1);
  });
});
