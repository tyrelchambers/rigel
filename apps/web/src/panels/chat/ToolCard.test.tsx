// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ToolCard } from "./ToolCard";
import type { ToolActivity } from "./types";

afterEach(cleanup);

const tool = (over: Partial<ToolActivity>): ToolActivity => ({
  id: "t1",
  name: "Bash",
  inputJSON: "{}",
  status: "ok",
  ...over,
});

describe("ToolCard target pill", () => {
  it("shows cluster and namespace parsed from a kubectl command", () => {
    render(<ToolCard tool={tool({ command: "kubectl --context prod-cluster -n default get pods" })} />);
    expect(screen.getByText("prod-cluster · default")).toBeInTheDocument();
  });

  it("shows just the cluster when there is no namespace flag", () => {
    render(<ToolCard tool={tool({ command: "kubectl --context prod get nodes" })} />);
    expect(screen.getByText("prod")).toBeInTheDocument();
  });

  it("shows no pill for a non-kubectl command", () => {
    render(<ToolCard tool={tool({ command: "echo hello" })} />);
    expect(screen.queryByText(/·/)).toBeNull();
  });
});
