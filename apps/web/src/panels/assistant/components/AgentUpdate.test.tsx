// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentUpdate, AgentUpdateView } from "./AgentUpdate";
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

const runSuggestion = vi.fn();
let ctxValue: {
  d: { agentImage: string | null; agentContainer: string | null; installedNamespace: string | null; stateNamespace: string };
  runSuggestion: typeof runSuggestion;
};
let updatesValue: Map<string, { result?: UpdateResult; isPending: boolean }>;

vi.mock("../AssistantContext", () => ({ useAssistantCtx: () => ctxValue }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  useUpdatesByImage: () => updatesValue,
}));

describe("AgentUpdate (smart wrapper)", () => {
  beforeEach(() => {
    runSuggestion.mockReset();
    ctxValue = {
      d: {
        agentImage: "ghcr.io/x/rigel-assistant:0.1.412",
        agentContainer: "agent",
        installedNamespace: "team-a",
        stateNamespace: "team-a",
      },
      runSuggestion,
    };
    updatesValue = new Map([
      [
        "ghcr.io/x/rigel-assistant:0.1.412",
        {
          result: {
            image: "ghcr.io/x/rigel-assistant:0.1.412",
            currentTag: "0.1.412",
            latest: "0.1.415",
            updateAvailable: true,
            kind: "version",
          },
          isPending: false,
        },
      ],
    ]);
  });

  it("fires a setImage ConfirmSheet with the resolved latest tag", () => {
    render(<AgentUpdate />);
    fireEvent.click(screen.getByRole("button", { name: /update/i }));
    expect(runSuggestion).toHaveBeenCalledWith({
      kind: "setImage",
      label: "Update agent to 0.1.415",
      name: "rigel-assistant",
      namespace: "team-a",
      resourceKind: "deployment",
      container: "agent",
      image: "ghcr.io/x/rigel-assistant:0.1.415",
    });
  });

  it("renders nothing when there is no agent image", () => {
    ctxValue.d.agentImage = null;
    const { container } = render(<AgentUpdate />);
    expect(container).toBeEmptyDOMElement();
  });
});
