// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@/components/RigelMark", () => ({ RigelMark: () => null }));

import { NavLauncher } from "./NavLauncher";
import { NAV_FAVORITES_KEY } from "./navFavorites";

function renderOpen() {
  return render(
    <MemoryRouter>
      <NavLauncher open onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

const selectedCount = (c: HTMLElement) => c.querySelectorAll('[aria-selected="true"]').length;

describe("NavLauncher render layer", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("reveals the favorite star on hover for non-favorited cells", () => {
    renderOpen();
    // A non-favorited cell's star is hidden by default but revealed on hover.
    const addStar = screen.getByLabelText("Favorite Pods");
    expect(addStar.className).toContain("opacity-0");
    expect(addStar.className).toContain("group-hover:opacity-100");
  });

  it("keeps the favorited star visible", () => {
    localStorage.setItem(NAV_FAVORITES_KEY, JSON.stringify(["secrets"]));
    renderOpen();
    // Secrets is favorited → its star buttons are always visible (favorites +
    // its category copy both read aria-label 'Unfavorite Secrets').
    for (const star of screen.getAllByLabelText("Unfavorite Secrets")) {
      expect(star.className).toContain("opacity-100");
      expect(star.className).not.toContain("opacity-0");
    }
  });

  it("highlights exactly one cell even when a favorite is duplicated in its group", () => {
    localStorage.setItem(NAV_FAVORITES_KEY, JSON.stringify(["secrets"]));
    const { container } = renderOpen();

    // Secrets appears twice: once in Favorites, once in Config & Storage.
    expect(screen.getAllByText("Secrets")).toHaveLength(2);

    const dialog = screen.getByRole("dialog");
    // Initial selection + several moves: never 0, never 2 highlighted.
    expect(selectedCount(container)).toBe(1);
    for (const key of ["ArrowRight", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowUp"]) {
      fireEvent.keyDown(dialog, { key });
      expect(selectedCount(container)).toBe(1);
    }
  });
});
