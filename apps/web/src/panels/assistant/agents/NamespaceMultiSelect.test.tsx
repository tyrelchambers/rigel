// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NamespaceMultiSelect } from "./NamespaceMultiSelect";
import { useCluster } from "@/store/cluster";

beforeEach(() => {
  useCluster.setState({
    resources: {
      namespaces: {
        default: { metadata: { name: "default" } },
        "kube-system": { metadata: { name: "kube-system" } },
        monitoring: { metadata: { name: "monitoring" } },
      },
    },
  });
});

describe("NamespaceMultiSelect", () => {
  it("shows 'All namespaces' when the selection is empty", () => {
    render(<NamespaceMultiSelect value={[]} onChange={() => {}} />);
    expect(screen.getByText("All namespaces")).toBeInTheDocument();
  });

  it("lists the cluster namespaces and toggles one on", async () => {
    const onChange = vi.fn();
    render(<NamespaceMultiSelect value={[]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /monitor namespaces/i }));
    await userEvent.click(screen.getByRole("option", { name: /monitoring/i }));
    expect(onChange).toHaveBeenCalledWith(["monitoring"]);
  });

  it("deselects an already-selected namespace", async () => {
    const onChange = vi.fn();
    render(<NamespaceMultiSelect value={["default", "monitoring"]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /monitor namespaces/i }));
    await userEvent.click(screen.getByRole("option", { name: /default/i }));
    expect(onChange).toHaveBeenCalledWith(["monitoring"]);
  });

  it("filters the list by the search query", async () => {
    render(<NamespaceMultiSelect value={[]} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /monitor namespaces/i }));
    await userEvent.type(screen.getByLabelText(/filter namespaces/i), "mon");
    expect(screen.getByRole("option", { name: /monitoring/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /kube-system/i })).not.toBeInTheDocument();
  });

  it("removes a namespace via its chip without opening the dropdown", async () => {
    const onChange = vi.fn();
    render(<NamespaceMultiSelect value={["default"]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /remove default/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
