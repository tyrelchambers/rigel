// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AppUpdateChip } from "./AppUpdateChip";
import type { UseAppUpdateResult } from "./useAppUpdate";

const download = vi.fn();
const install = vi.fn();
const open = vi.fn();

let state: Pick<UseAppUpdateResult, "status" | "version" | "progress" | "canAutoInstall">;

vi.mock("./useAppUpdate", () => ({
  useAppUpdate: (): UseAppUpdateResult => ({ ...state, download, install, open }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppUpdateChip", () => {
  it("renders nothing when idle", () => {
    state = { status: "idle", version: null, progress: 0, canAutoInstall: false };
    const { container } = render(<AppUpdateChip />);
    expect(container.firstChild).toBeNull();
  });

  it("available + auto-install → 'Update to X', click downloads", () => {
    state = { status: "available", version: "0.2.4", progress: 0, canAutoInstall: true };
    render(<AppUpdateChip />);
    const btn = screen.getByRole("button", { name: /update to 0\.2\.4/i });
    expect(screen.getByText("Update to")).toBeTruthy();
    btn.click();
    expect(download).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("available without auto-install → 'Update available', click opens download page", () => {
    state = { status: "available", version: "0.2.4", progress: 0, canAutoInstall: false };
    render(<AppUpdateChip />);
    const btn = screen.getByRole("button", { name: /update available: 0\.2\.4/i });
    expect(screen.getByText("Update available")).toBeTruthy();
    btn.click();
    expect(open).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });

  it("downloading → shows progress, no action button", () => {
    state = { status: "downloading", version: "0.2.4", progress: 61, canAutoInstall: true };
    render(<AppUpdateChip />);
    expect(screen.getByText("61%")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("downloaded → 'Restart to update', click installs", () => {
    state = { status: "downloaded", version: "0.2.4", progress: 100, canAutoInstall: true };
    render(<AppUpdateChip />);
    const btn = screen.getByRole("button", { name: /restart to update/i });
    btn.click();
    expect(install).toHaveBeenCalledOnce();
  });
});
