// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HeartPulse } from "lucide-react";
import { AuditSkillsTab } from "./AuditSkillsTab";
import { AuditSkillCard } from "../audits/AuditSkillCard";

vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
import { handoffToChat } from "@/lib/chatHandoff";

beforeEach(() => vi.clearAllMocks());

describe("AuditSkillsTab", () => {
  it("renders all three audit cards as live launchers with no 'Coming soon'", () => {
    render(<AuditSkillsTab />);
    expect(screen.getByText("Reliability")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("Performance")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /run audit/i })).toHaveLength(3);
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("hands off /rigel-reliability-audit to a new chat thread on Run", () => {
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: /run audit/i })[0]);
    expect(handoffToChat).toHaveBeenCalledWith("/rigel-reliability-audit", { newThread: true });
  });

  it("hands off /rigel-security-audit to a new chat thread on Run", () => {
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: /run audit/i })[1]);
    expect(handoffToChat).toHaveBeenCalledWith("/rigel-security-audit", { newThread: true });
  });

  it("hands off /rigel-performance-audit to a new chat thread on Run", () => {
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: /run audit/i })[2]);
    expect(handoffToChat).toHaveBeenCalledWith("/rigel-performance-audit", { newThread: true });
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
