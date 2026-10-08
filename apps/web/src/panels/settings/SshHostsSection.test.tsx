// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mutate = vi.fn();
let hosts: unknown[] = [];

vi.mock("@/lib/api", () => ({
  useSshHosts: () => ({ data: hosts, isLoading: false }),
  useSetSshHosts: () => ({ mutate, isPending: false, error: null }),
}));

import { SshHostsSection } from "./SshHostsSection";

const sample = [
  { alias: "web-1", hostName: "10.0.0.5", user: "root", port: "22", enabled: true },
  { alias: "nas", hostName: "nas.lan", user: "admin", port: "22", enabled: false },
];

describe("SshHostsSection", () => {
  it("lists hosts with their resolved address and the enabled count", () => {
    hosts = sample;
    render(<SshHostsSection />);
    expect(screen.getByText("web-1")).toBeTruthy();
    expect(screen.getByText("admin@nas.lan:22")).toBeTruthy();
    expect(screen.getByText("1 of 2 enabled")).toBeTruthy();
  });

  it("toggling sends the full enabled list in order", () => {
    hosts = sample;
    render(<SshHostsSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Allow chat on nas" }));
    expect(mutate).toHaveBeenCalledWith(["web-1", "nas"]);
  });

  it("toggling an enabled host removes it", () => {
    hosts = sample;
    render(<SshHostsSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Allow chat on web-1" }));
    expect(mutate).toHaveBeenCalledWith([]);
  });

  it("shows the empty state when there are no hosts", () => {
    hosts = [];
    render(<SshHostsSection />);
    expect(screen.getByText("No hosts found in ~/.ssh/config.")).toBeTruthy();
  });
});
