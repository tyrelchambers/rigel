// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuditSkillsTab } from "./AuditSkillsTab";

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
