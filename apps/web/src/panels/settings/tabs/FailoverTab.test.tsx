// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { FailoverTab } from "./FailoverTab";

const mutate = vi.fn();

const view = {
  configured: false,
  provider: "digitalocean" as const,
  tokenSet: false,
  spacesKeySet: false,
  spacesSecretSet: false,
  region: "tor1",
  nodeSize: "s-4vcpu-8gb",
  nodeCount: 2,
  cluster: { context: "home", namespace: "rigel", secret: "rigel-user-config", state: "ok" as const },
};

vi.mock("@/lib/api", () => ({
  useFailoverConfig: () => ({ data: view }),
  useSaveFailoverConfig: () => ({ mutate, isPending: false, isSuccess: false, error: null }),
}));

describe("FailoverTab", () => {
  it("no longer asks for object store credentials the flat form could not use", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FailoverTab />
      </QueryClientProvider>,
    );
    expect(screen.queryByLabelText(/spaces/i)).not.toBeInTheDocument();
  });

  it("saves the DigitalOcean destination from the form", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FailoverTab />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/failover destination/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/digitalocean api token/i), { target: { value: "dop_v1_abc" } });
    fireEvent.click(screen.getByRole("button", { name: /save destination/i }));
    expect(mutate).toHaveBeenCalledWith({
      region: "tor1",
      nodeSize: "s-4vcpu-8gb",
      nodeCount: 2,
      token: "dop_v1_abc",
    });
  });
});
