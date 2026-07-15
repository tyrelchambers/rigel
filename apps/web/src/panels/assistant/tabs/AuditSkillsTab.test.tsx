// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HeartPulse } from "lucide-react";
import { DEFAULT_AUDIT_ENTITLEMENT } from "@rigel/k8s";
import { AuditSkillsTab } from "./AuditSkillsTab";
import { AuditSkillCard } from "../audits/AuditSkillCard";

vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
import { handoffToChat } from "@/lib/chatHandoff";

vi.mock("../audits/useAuditEntitlement", () => ({ useAuditEntitlement: vi.fn() }));
import { useAuditEntitlement } from "../audits/useAuditEntitlement";

vi.mock("@/shell/useEntitlement", () => ({ useEntitlement: vi.fn() }));
import { useEntitlement } from "@/shell/useEntitlement";

vi.mock("@/shell/useAccount", () => ({ useAccount: vi.fn() }));
import { useAccount } from "@/shell/useAccount";

const upgrade = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuditEntitlement).mockReturnValue(DEFAULT_AUDIT_ENTITLEMENT);
  vi.mocked(useEntitlement).mockReturnValue({ payload: null, upgrade });
  vi.mocked(useAccount).mockReturnValue({
    orgs: [{ id: "org-personal", kind: "personal", name: "Me", role: "owner" }],
  } as never);
});

describe("AuditSkillsTab", () => {
  it("renders all three audit cards as live launchers when everything is unlocked", () => {
    render(<AuditSkillsTab />);
    expect(screen.getByText("Reliability")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("Performance")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /run audit/i })).toHaveLength(3);
    expect(screen.queryByText("Upgrade")).not.toBeInTheDocument();
  });

  it("hands off /rigel-reliability-audit to a new thread with a friendly bubble label", () => {
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: /run audit/i })[0]);
    expect(handoffToChat).toHaveBeenCalledWith(
      "/rigel-reliability-audit",
      expect.objectContaining({ newThread: true, displayText: expect.stringContaining("reliability audit") }),
    );
  });

  it("hands off /rigel-security-audit to a new thread with a friendly bubble label", () => {
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: /run audit/i })[1]);
    expect(handoffToChat).toHaveBeenCalledWith(
      "/rigel-security-audit",
      expect.objectContaining({ newThread: true, displayText: expect.stringContaining("security audit") }),
    );
  });

  it("hands off /rigel-performance-audit to a new thread with a friendly bubble label", () => {
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getAllByRole("button", { name: /run audit/i })[2]);
    expect(handoffToChat).toHaveBeenCalledWith(
      "/rigel-performance-audit",
      expect.objectContaining({ newThread: true, displayText: expect.stringContaining("performance audit") }),
    );
  });

  it("locks an audit the entitlement does not unlock, blocking its launch", () => {
    vi.mocked(useAuditEntitlement).mockReturnValue({ unlocked: ["reliability", "performance"] });
    render(<AuditSkillsTab />);
    expect(screen.getAllByRole("button", { name: /run audit/i })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /upgrade to unlock/i })).toBeInTheDocument();
    expect(screen.getByText(/security audit is a premium skill/i)).toBeInTheDocument();
    expect(handoffToChat).not.toHaveBeenCalled();
  });

  it("clicking Upgrade on a gated skill calls upgrade with the personal org id", () => {
    vi.mocked(useAuditEntitlement).mockReturnValue({ unlocked: ["reliability", "performance"] });
    render(<AuditSkillsTab />);
    fireEvent.click(screen.getByRole("button", { name: /upgrade to unlock/i }));
    expect(upgrade).toHaveBeenCalledWith("org-personal");
  });
});

describe("AuditSkillCard count summary", () => {
  it("shows the empty state when total is 0", () => {
    render(
      <AuditSkillCard
        title="Reliability"
        description="d"
        Icon={HeartPulse}
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
        counts={{ critical: 1, warning: 2, info: 1, total: 4, workloadsAffected: 3 }}
      />,
    );
    expect(screen.getByText("1 critical")).toBeInTheDocument();
    expect(screen.getByText("2 warning")).toBeInTheDocument();
    expect(screen.getByText("1 info")).toBeInTheDocument();
    expect(screen.queryByText("No issues found")).not.toBeInTheDocument();
  });

  it("renders the locked treatment with its reason instead of a run button", () => {
    render(
      <AuditSkillCard
        title="Security"
        description="d"
        Icon={HeartPulse}
        locked={{ reason: "Upgrade to unlock it." }}
      />,
    );
    expect(screen.getByText("Upgrade")).toBeInTheDocument();
    expect(screen.getByText("Upgrade to unlock it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run audit/i })).not.toBeInTheDocument();
  });
});
