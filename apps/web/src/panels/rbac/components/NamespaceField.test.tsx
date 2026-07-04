// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/store/cluster", () => ({
  useCluster: (sel: (s: { resources: Record<string, Record<string, unknown>> }) => unknown) =>
    sel({ resources: { namespaces: { default: {}, "kube-system": {} } } }),
}));

import { NamespaceField } from "./NamespaceField";

afterEach(cleanup);

test("lists namespaces and fires onChange", () => {
  const onChange = vi.fn();
  render(<NamespaceField value="default" onChange={onChange} />);
  const select = screen.getByRole("combobox");
  expect(screen.getByRole("option", { name: "kube-system" })).toBeTruthy();
  fireEvent.change(select, { target: { value: "kube-system" } });
  expect(onChange).toHaveBeenCalledWith("kube-system");
});
