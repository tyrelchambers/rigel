// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AssistantBody } from "./AssistantBody";
import type { AssistantContextValue, AssistantPhase } from "./AssistantContext";
import type { EntitlementPayload } from "@/lib/desktop";

vi.mock("./AssistantContext", () => ({ useAssistantCtx: vi.fn() }));
import { useAssistantCtx } from "./AssistantContext";

vi.mock("@/shell/useEntitlement", () => ({ useEntitlement: vi.fn() }));
import { useEntitlement } from "@/shell/useEntitlement";

vi.mock("./components/StatusStrip", () => ({ StatusStrip: () => <div>status-strip</div> }));
vi.mock("./components/TabBar", () => ({ TabBar: () => <div>tab-bar</div> }));
vi.mock("./components/TabContent", () => ({ TabContent: () => <div>tab-content</div> }));
vi.mock("./components/AssistantGate", () => ({ AssistantGate: () => <div>assistant-gate</div> }));

const entPayload = (agentAutonomy: boolean): EntitlementPayload => ({
  plan: agentAutonomy ? "pro" : "free", audits: [], cloudConnect: false, agentAutonomy, fetchedAt: "t",
});

function setCtx(phase: AssistantPhase) {
  vi.mocked(useAssistantCtx).mockReturnValue({ actionError: null, phase } as unknown as AssistantContextValue);
}

beforeEach(() => {
  vi.mocked(useEntitlement).mockReset();
});

describe("AssistantBody", () => {
  it("renders the gate (no tabs) when ready and not entitled", () => {
    setCtx("ready");
    vi.mocked(useEntitlement).mockReturnValue({ payload: entPayload(false), upgrade: vi.fn() });
    render(<AssistantBody />);
    expect(screen.getByText("assistant-gate")).toBeInTheDocument();
    expect(screen.queryByText("tab-bar")).not.toBeInTheDocument();
  });

  it("renders the normal body when ready and entitled", () => {
    setCtx("ready");
    vi.mocked(useEntitlement).mockReturnValue({ payload: entPayload(true), upgrade: vi.fn() });
    render(<AssistantBody />);
    expect(screen.getByText("tab-bar")).toBeInTheDocument();
    expect(screen.queryByText("assistant-gate")).not.toBeInTheDocument();
  });

  it("renders the normal body for non-ready phases even when not entitled", () => {
    setCtx("install");
    vi.mocked(useEntitlement).mockReturnValue({ payload: entPayload(false), upgrade: vi.fn() });
    render(<AssistantBody />);
    expect(screen.getByText("tab-bar")).toBeInTheDocument();
    expect(screen.queryByText("assistant-gate")).not.toBeInTheDocument();
  });
});
