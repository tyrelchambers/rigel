// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AppUpdateChip } from "./AppUpdateChip";

const open = vi.fn();
let state: { updateAvailable: boolean; latestVersion: string | null } = {
  updateAvailable: false,
  latestVersion: null,
};

vi.mock("./useAppUpdate", () => ({
  useAppUpdate: () => ({ ...state, open }),
}));

afterEach(cleanup);

describe("AppUpdateChip", () => {
  it("renders nothing when up to date", () => {
    state = { updateAvailable: false, latestVersion: null };
    const { container } = render(<AppUpdateChip />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the pill with the version and opens the download page on click", () => {
    state = { updateAvailable: true, latestVersion: "0.2.1" };
    render(<AppUpdateChip />);
    const btn = screen.getByRole("button", { name: /update available: rigel 0\.2\.1/i });
    expect(screen.getByText("Update available")).toBeTruthy();
    expect(screen.getByText("0.2.1")).toBeTruthy();
    btn.click();
    expect(open).toHaveBeenCalledOnce();
  });
});
