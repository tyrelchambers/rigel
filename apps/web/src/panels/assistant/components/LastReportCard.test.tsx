// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { LastReportCard } from "./LastReportCard";
import { useCluster } from "@/store/cluster";

const navigate = vi.fn();
vi.mock("react-router", async (orig) => ({
  ...(await orig<typeof import("react-router")>()),
  useNavigate: () => navigate,
}));

const SILENCED = [
  "loggedError|default|canadahires-api-7845596fdb-r6xz5|ConnectionReset",
  "loggedError|default|canadahires-api-7845596fdb-xrl27|ConnectionReset",
  "unhealthyPod|default|web-abc|CrashLoopBackOff",
  "degradedDeployment|prod|billing|Degraded",
  "loggedError|default|worker-def|Timeout",
  "loggedError|default|worker-ghi|Timeout",
];

function wrap(props: Partial<React.ComponentProps<typeof LastReportCard>> = {}) {
  return render(
    <MemoryRouter>
      <LastReportCard
        report={`Auto-silenced ${SILENCED.length} benign issue(s): default/canadahires-api-7845596fdb-r6xz5, +${SILENCED.length - 1} more`}
        autoSilenced={SILENCED}
        autoSilencedReasons={{}}
        working={false}
        onClear={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("LastReportCard", () => {
  beforeEach(() => {
    navigate.mockReset();
    useCluster.setState({ focusRequest: null, namespaceFilter: "all" });
  });

  it("summarizes the count and shows a collapsed subset with a Show all toggle", () => {
    wrap();
    expect(screen.getByText("6")).toBeInTheDocument();
    // Collapsed to 4 rows: the 5th/6th resources are hidden until expanded.
    expect(screen.getByText("web-abc")).toBeInTheDocument();
    expect(screen.queryByText("worker-ghi")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show all 6/i }));
    expect(screen.getByText("worker-ghi")).toBeInTheDocument();
  });

  it("expands a row to reveal what was skipped", () => {
    wrap();
    fireEvent.click(screen.getByText("web-abc"));
    expect(screen.getByText(/unhealthy pod, evaluated and auto-silenced as benign/i)).toBeInTheDocument();
    expect(screen.getByText("default / web-abc")).toBeInTheDocument();
    // With no reason map, the Reason falls back to the fingerprint signature.
    expect(screen.getAllByText("CrashLoopBackOff").length).toBeGreaterThan(0);
  });

  it("shows the raw human reason when the reasons map carries one", () => {
    const fp = SILENCED[0]; // loggedError|default|canadahires-api-7845596fdb-r6xz5|ConnectionReset
    wrap({ autoSilencedReasons: { [fp]: "fatal: connection reset by peer while reading DB socket" } });
    fireEvent.click(screen.getByText("canadahires-api-7845596fdb-r6xz5"));
    expect(
      screen.getAllByText("fatal: connection reset by peer while reading DB socket").length,
    ).toBeGreaterThan(0);
  });

  it("shows a full-log expander when the reason spans many lines", () => {
    const fp = SILENCED[2]; // unhealthyPod|default|web-abc|CrashLoopBackOff
    const many = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");
    wrap({ autoSilencedReasons: { [fp]: many } });
    fireEvent.click(screen.getByText("web-abc"));
    expect(screen.getByText("6 of 14 lines")).toBeInTheDocument();
    expect(screen.queryByText("line 14")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show full log/i }));
    expect(screen.getByText("line 14")).toBeInTheDocument();
  });

  it("navigates to the pod (namespace-scoped, search-seeded) via Open", () => {
    wrap();
    fireEvent.click(screen.getByText("web-abc"));
    fireEvent.click(screen.getByRole("button", { name: /open in pods/i }));
    expect(navigate).toHaveBeenCalledWith("/pods");
    const st = useCluster.getState();
    expect(st.namespaceFilter).toBe("default");
    expect(st.focusRequest).toEqual({
      route: "/pods",
      kind: "pod",
      key: "default/web-abc",
      search: "web-abc",
    });
  });

  it("routes a degraded deployment to the Deployments panel", () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /show all 6/i }));
    fireEvent.click(screen.getByText("billing"));
    fireEvent.click(screen.getByRole("button", { name: /open in deployments/i }));
    expect(navigate).toHaveBeenCalledWith("/deployments");
    expect(useCluster.getState().focusRequest).toEqual({
      route: "/deployments",
      kind: "deployment",
      key: "prod/billing",
      search: "billing",
    });
  });

  it("falls back to raw report text when there is nothing structured", () => {
    wrap({ report: "Watched cluster; nothing to do.", autoSilenced: [] });
    expect(screen.getByText("Watched cluster; nothing to do.")).toBeInTheDocument();
  });
});
