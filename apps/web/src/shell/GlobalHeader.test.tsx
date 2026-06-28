// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./NamespaceBar", () => ({ NamespaceSelector: () => null }));
vi.mock("@/components/RigelMark", () => ({ RigelMark: () => null }));
vi.mock("@/store/cluster", () => ({ useCluster: () => false }));

import { GlobalHeader } from "./GlobalHeader";

afterEach(cleanup);

test("renders an Account button that calls onOpenAccount", () => {
  const onOpenAccount = vi.fn();
  render(
    <GlobalHeader
      sidebarCollapsed={false}
      onToggleSidebar={vi.fn()}
      onOpenSearch={vi.fn()}
      onOpenAccount={onOpenAccount}
    />,
  );
  fireEvent.click(screen.getByLabelText("Account"));
  expect(onOpenAccount).toHaveBeenCalledTimes(1);
});
