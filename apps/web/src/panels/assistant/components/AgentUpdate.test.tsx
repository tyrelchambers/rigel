// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentUpdateView } from "./AgentUpdate";
import type { UpdateResult } from "@/lib/api";

const base: UpdateResult = {
  image: "ghcr.io/x/rigel-assistant:0.1.412",
  currentTag: "0.1.412",
  latest: null,
  updateAvailable: false,
  kind: "none",
};

describe("AgentUpdateView", () => {
  it("renders nothing while the result is undefined", () => {
    const { container } = render(<AgentUpdateView result={undefined} onUpdate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows current -> latest and updates on click", () => {
    const onUpdate = vi.fn();
    render(
      <AgentUpdateView
        result={{ ...base, latest: "0.1.415", updateAvailable: true, kind: "version" }}
        onUpdate={onUpdate}
      />,
    );
    expect(screen.getByText("0.1.412")).toBeInTheDocument();
    expect(screen.getByText("0.1.415")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /update/i }));
    expect(onUpdate).toHaveBeenCalledWith("0.1.415");
  });

  it("shows the latest and Update button even when currentTag is null", () => {
    const onUpdate = vi.fn();
    render(
      <AgentUpdateView
        result={{ ...base, currentTag: null, latest: "0.1.415", updateAvailable: true, kind: "version" }}
        onUpdate={onUpdate}
      />,
    );
    expect(screen.getByText("0.1.415")).toBeInTheDocument();
    expect(screen.queryByText("→")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /update/i }));
    expect(onUpdate).toHaveBeenCalledWith("0.1.415");
  });

  it("shows an up-to-date state with no button", () => {
    render(<AgentUpdateView result={{ ...base, currentTag: "0.1.415" }} onUpdate={vi.fn()} />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an unreachable state with the reason as a tooltip", () => {
    render(
      <AgentUpdateView
        result={{ ...base, kind: "unknown", reason: "registry returned HTTP 503" }}
        onUpdate={vi.fn()}
      />,
    );
    const el = screen.getByText(/couldn't check/i);
    expect(el).toBeInTheDocument();
    expect(el.closest("[title]")?.getAttribute("title")).toBe("registry returned HTTP 503");
  });
});
