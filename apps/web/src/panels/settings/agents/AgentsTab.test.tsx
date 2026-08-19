// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AgentsResponse, AgentView } from "@/lib/api";

let current: AgentsResponse;

vi.mock("@/lib/api", () => ({
  useAgents: () => ({ data: current, isLoading: false }),
  connectionLabel: (c: string) => c,
  useSetActiveAgent: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useSetAgentAuth: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
}));

import { AgentsTab } from "./AgentsTab";

const claude: AgentView = {
  id: "claude",
  label: "Claude Code",
  vendor: "Anthropic",
  status: "available",
  connection: "notSignedIn",
  authMethods: ["subscription", "apiKey"],
  authMethod: "apiKey",
  apiKeySet: true,
  installUrl: "https://x",
  installLabel: "Install Claude Code",
};

function response(over: Partial<AgentsResponse> = {}): AgentsResponse {
  return {
    activeAgentId: "claude",
    agents: [claude],
    cluster: { context: "prod-cluster", namespace: "default", secret: "rigel-user-config", state: "ok" },
    ...over,
  };
}

describe("AgentsTab", () => {
  it("names the Secret and cluster the agent credentials are saved in", () => {
    current = response();
    render(<AgentsTab />);
    expect(screen.getByText("rigel-user-config")).toBeInTheDocument();
    expect(screen.getByText("default")).toBeInTheDocument();
    expect(screen.getByText("prod-cluster")).toBeInTheDocument();
  });

  it("keeps naming it on the setup screen where the key is pasted", () => {
    current = response();
    render(<AgentsTab />);
    fireEvent.click(screen.getByRole("button", { name: /claude code/i }));
    expect(screen.getByText("rigel-user-config")).toBeInTheDocument();
    expect(screen.getByLabelText(/claude code api key/i)).toBeInTheDocument();
  });

  it("with the cluster unreachable, says why and locks the key field", () => {
    current = response({
      cluster: {
        context: "prod-cluster",
        namespace: "default",
        secret: "rigel-user-config",
        state: "unavailable",
        message: "The connection to the server 127.0.0.1:6443 was refused",
      },
    });
    render(<AgentsTab />);
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
    expect(screen.getByText(/connection to the server/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /claude code/i }));
    expect(screen.getByLabelText(/claude code api key/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("renders without a cluster status at all, as the onboarding wizard mounts it", () => {
    current = response({ cluster: undefined });
    render(<AgentsTab hideHeading />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.queryByText("rigel-user-config")).toBeNull();
  });
});
