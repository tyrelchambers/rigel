// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./NamespaceBar", () => ({ NamespaceSelector: () => null }));
vi.mock("./useNavHistory", () => ({
  useNavHistory: () => ({
    canGoBack: false,
    canGoForward: false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  }),
}));
vi.mock("@/store/cluster", () => ({ useCluster: () => false }));

import { GlobalHeader } from "./GlobalHeader";

afterEach(cleanup);

test("shows no Account affordance: local use needs no sign-in", () => {
  render(<GlobalHeader onOpenSearch={vi.fn()} onOpenAccount={vi.fn()} />);
  expect(screen.queryByLabelText("Account")).toBeNull();
});

test("still renders the search button", () => {
  const onOpenSearch = vi.fn();
  render(<GlobalHeader onOpenSearch={onOpenSearch} onOpenAccount={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("Search"));
  expect(onOpenSearch).toHaveBeenCalledTimes(1);
});
