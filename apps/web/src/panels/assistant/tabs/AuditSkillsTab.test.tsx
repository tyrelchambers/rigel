// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HeartPulse } from "lucide-react";
import { AuditSkillsTab } from "./AuditSkillsTab";
import { AuditSkillCard } from "../audits/AuditSkillCard";

vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
import { handoffToChat } from "@/lib/chatHandoff";

vi.mock("../audits/useReliabilityAudit", () => ({
  useReliabilityAudit: () => ({
    findings: [
      { type: "singleReplica", severity: "warning", kind: "Deployment", name: "web", namespace: "default", rationale: "x", fix: "y" },
    ],
    counts: { critical: 0, warning: 1, info: 0, total: 1, workloadsAffected: 1 },
  }),
}));

beforeEach(() => vi.clearAllMocks());

describe("AuditSkillsTab", () => {
  it("renders the Reliability card and Coming soon cards", () => {
    render(<AuditSkillsTab />);
    expect(screen.getByText("Reliability")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("Performance")).toBeInTheDocument();
    expect(screen.getAllByText("Coming soon")).toHaveLength(2);
  });

  it("hands off a findings-seeded prompt to a new chat thread on Run", () => {
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getByRole("button", { name: /run audit/i }));
    expect(handoffToChat).toHaveBeenCalledWith(
      expect.stringContaining('"type": "singleReplica"'),
      { newThread: true },
    );
  });
});

describe("AuditSkillCard count summary", () => {
  it("shows the empty state when total is 0", () => {
    render(
      <AuditSkillCard
        title="Reliability"
        description="d"
        Icon={HeartPulse}
        status="live"
        counts={{ critical: 0, warning: 0, info: 0, total: 0, workloadsAffected: 0 }}
      />,
    );
    expect(screen.getByText("No issues found")).toBeInTheDocument();
  });

  it("renders critical, warning, and info chips for a multi-severity count", () => {
    render(
      <AuditSkillCard
        title="Reliability"
        description="d"
        Icon={HeartPulse}
        status="live"
        counts={{ critical: 1, warning: 2, info: 1, total: 4, workloadsAffected: 3 }}
      />,
    );
    expect(screen.getByText("1 critical")).toBeInTheDocument();
    expect(screen.getByText("2 warning")).toBeInTheDocument();
    expect(screen.getByText("1 info")).toBeInTheDocument();
    expect(screen.queryByText("No issues found")).not.toBeInTheDocument();
  });
});
