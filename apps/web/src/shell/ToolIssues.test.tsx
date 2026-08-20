// @vitest-environment jsdom
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolIssues } from "./ToolIssues";
import { useCluster, type MissingTool } from "@/store/cluster";

const sendToolsRecheck = vi.fn();
vi.mock("@/lib/ws", () => ({ sendToolsRecheck: () => sendToolsRecheck() }));

const KUBECTL: MissingTool = { bin: "kubectl", installUrl: "https://kubernetes.io/docs/tasks/tools/" };
const HELM: MissingTool = { bin: "helm", installUrl: "https://helm.sh/docs/intro/install/" };

function setMissing(tools: MissingTool[]) {
  useCluster.getState().setMissingTools(tools);
}

beforeEach(() => {
  sendToolsRecheck.mockClear();
  setMissing([]);
});

afterEach(() => cleanup());

describe("ToolIssues", () => {
  test("renders nothing while every binary resolves", () => {
    const { container } = render(<ToolIssues />);
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the indicator once a binary is missing", () => {
    setMissing([KUBECTL]);
    render(<ToolIssues />);
    expect(screen.getByRole("button", { name: "1 tool issue" })).toBeInTheDocument();
  });

  test("the popover names the binary, the consequence, and links to the install page", async () => {
    setMissing([KUBECTL]);
    render(<ToolIssues />);

    await userEvent.click(screen.getByRole("button", { name: "1 tool issue" }));

    await waitFor(() => expect(screen.getByText("kubectl not found")).toBeInTheDocument());
    expect(screen.getByText("Watches, logs, metrics and port-forward can't run.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Install kubectl/ });
    expect(link).toHaveAttribute("href", "https://kubernetes.io/docs/tasks/tools/");
  });

  test("the install link opens externally rather than navigating the app window", async () => {
    setMissing([KUBECTL]);
    render(<ToolIssues />);
    await userEvent.click(screen.getByRole("button", { name: "1 tool issue" }));

    await waitFor(() => expect(screen.getByRole("link", { name: /Install kubectl/ })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Install kubectl/ })).toHaveAttribute("target", "_blank");
  });

  test("lists one row per missing binary, each with its own link", async () => {
    setMissing([KUBECTL, HELM]);
    render(<ToolIssues />);

    await userEvent.click(screen.getByRole("button", { name: "2 tool issues" }));

    await waitFor(() => expect(screen.getByText("kubectl not found")).toBeInTheDocument());
    expect(screen.getByText("helm not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Install helm/ })).toHaveAttribute(
      "href",
      "https://helm.sh/docs/intro/install/",
    );
  });

  test("Check again asks the server to re-probe", async () => {
    setMissing([KUBECTL]);
    render(<ToolIssues />);
    await userEvent.click(screen.getByRole("button", { name: "1 tool issue" }));

    await waitFor(() => expect(screen.getByText("Check again")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Check again"));

    expect(sendToolsRecheck).toHaveBeenCalledTimes(1);
  });

  test("disappears again once the binaries come back", () => {
    setMissing([KUBECTL]);
    const { container, rerender } = render(<ToolIssues />);
    expect(container).not.toBeEmptyDOMElement();

    setMissing([]);
    rerender(<ToolIssues />);

    expect(container).toBeEmptyDOMElement();
  });
});
