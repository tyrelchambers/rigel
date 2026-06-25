// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClusterHealthBadge } from "./ClusterHealthBadge";

test("renders a re-login affordance and fires onReconnect when clicked", () => {
  const onReconnect = vi.fn();
  render(<ClusterHealthBadge onReconnect={onReconnect} />);
  const btn = screen.getByRole("button", { name: /needs re-login/i });
  fireEvent.click(btn);
  expect(onReconnect).toHaveBeenCalled();
});
