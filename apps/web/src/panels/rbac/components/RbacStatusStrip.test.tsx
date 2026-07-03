// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RbacStatusStrip } from "./RbacStatusStrip";

afterEach(cleanup);

test("renders counts and switches scope", () => {
  const onScope = vi.fn();
  render(
    <RbacStatusStrip
      counts={{ subjects: 42, roles: 31, bindings: 24, dangerous: 3 }}
      scope="all"
      onScopeChange={onScope}
    />,
  );
  expect(screen.getByText("42")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
  expect(onScope).toHaveBeenCalledWith("cluster");
});
