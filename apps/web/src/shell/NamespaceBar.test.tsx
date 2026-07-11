// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NamespaceSelector } from "./NamespaceBar";
import { useCluster } from "@/store/cluster";

const ws = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/ws", () => ({ subscribe: ws.subscribe, unsubscribe: ws.unsubscribe }));

beforeEach(() => {
  ws.subscribe.mockClear();
  ws.unsubscribe.mockClear();
  useCluster.setState({
    resources: {},
    namespaceFilter: null,
    accessMode: "cluster-wide",
    accessNamespaces: [],
  });
});

function openDropdown() {
  fireEvent.click(screen.getByTitle("Select namespace filter"));
}

describe("NamespaceSelector — scoped mode", () => {
  beforeEach(() => {
    useCluster.setState({ accessMode: "scoped", accessNamespaces: ["team-a", "team-b"] });
  });

  it("lists the accessible namespaces without subscribing to the cluster-wide namespaces watch", () => {
    render(<NamespaceSelector />);
    openDropdown();

    expect(screen.getByText("team-a")).toBeInTheDocument();
    expect(screen.getByText("team-b")).toBeInTheDocument();
    expect(ws.subscribe).not.toHaveBeenCalledWith("namespaces", "*");
  });

  it("labels the all-namespaces option honestly as 'Your namespaces'", () => {
    render(<NamespaceSelector />);
    openDropdown();

    expect(screen.getAllByText("Your namespaces").length).toBeGreaterThan(0);
  });
});

describe("NamespaceSelector — cluster-wide mode", () => {
  it("subscribes to the cluster-wide namespaces watch and lists from it", () => {
    useCluster.setState({
      resources: { namespaces: { "team-a": { metadata: { name: "team-a" } } } },
    });
    render(<NamespaceSelector />);
    openDropdown();

    expect(ws.subscribe).toHaveBeenCalledWith("namespaces", "*");
    expect(screen.getByText("team-a")).toBeInTheDocument();
    expect(screen.getAllByText("All namespaces").length).toBeGreaterThan(0);
  });
});
