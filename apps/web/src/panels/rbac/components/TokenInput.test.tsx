// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TokenInput } from "./TokenInput";

afterEach(cleanup);

test("free-typed value still adds via Enter without suggestions", () => {
  const onChange = vi.fn();
  render(<TokenInput label="VERBS" tokens={["get"]} onChange={onChange} />);
  const input = screen.getByLabelText("Add VERBS");
  fireEvent.change(input, { target: { value: "*" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith(["get", "*"]);
});

test("clicking a suggestion adds the token", () => {
  const onChange = vi.fn();
  render(<TokenInput label="VERBS" tokens={["get"]} onChange={onChange} suggestions={["get", "list", "watch"]} />);
  const input = screen.getByLabelText("Add VERBS");
  fireEvent.focus(input);
  expect(screen.getByRole("button", { name: "list" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "watch" }));
  expect(onChange).toHaveBeenCalledWith(["get", "watch"]);
});

test("suggestions exclude already-added tokens", () => {
  render(<TokenInput label="VERBS" tokens={["get", "list"]} onChange={vi.fn()} suggestions={["get", "list", "watch"]} />);
  const input = screen.getByLabelText("Add VERBS");
  fireEvent.focus(input);
  expect(screen.queryByRole("button", { name: "get" })).toBeNull();
  expect(screen.queryByRole("button", { name: "list" })).toBeNull();
  expect(screen.getByRole("button", { name: "watch" })).toBeTruthy();
});

test("suggestions are filtered by the current input text", () => {
  render(<TokenInput label="VERBS" tokens={[]} onChange={vi.fn()} suggestions={["get", "list", "watch"]} />);
  const input = screen.getByLabelText("Add VERBS");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "wa" } });
  expect(screen.queryByRole("button", { name: "get" })).toBeNull();
  expect(screen.getByRole("button", { name: "watch" })).toBeTruthy();
});

test("Escape closes the suggestion dropdown", () => {
  render(<TokenInput label="VERBS" tokens={[]} onChange={vi.fn()} suggestions={["get", "list"]} />);
  const input = screen.getByLabelText("Add VERBS");
  fireEvent.focus(input);
  expect(screen.getByRole("button", { name: "get" })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "get" })).toBeNull();
});

test("no suggestions prop preserves existing chip/add behavior", () => {
  const onChange = vi.fn();
  render(<TokenInput label="RESOURCES" tokens={[]} onChange={onChange} />);
  const input = screen.getByLabelText("Add RESOURCES");
  fireEvent.change(input, { target: { value: "pods" } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenCalledWith(["pods"]);
});
