// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCluster } from "@/store/cluster";
import { FailoverSelect } from "./FailoverSelect";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

const deployments = {
  "default/reddex-deploy": {
    kind: "Deployment",
    metadata: { name: "reddex-deploy", namespace: "default" },
    spec: { replicas: 2, template: { metadata: { labels: { app: "reddex" } } } },
  },
  "default/esports-bot": {
    kind: "Deployment",
    metadata: { name: "esports-bot", namespace: "default" },
    spec: { replicas: 1, template: { metadata: { labels: { app: "bot" } } } },
  },
  "kube-system/traefik": {
    kind: "Deployment",
    metadata: { name: "traefik", namespace: "kube-system" },
    spec: { replicas: 3 },
  },
  "personal/outline": {
    kind: "Deployment",
    metadata: { name: "outline", namespace: "personal" },
    spec: { replicas: 1 },
  },
};

const services = {
  "default/reddex-svc": { metadata: { name: "reddex-svc", namespace: "default" }, spec: { selector: { app: "reddex" } } },
};
const ingresses = {
  "default/reddex": {
    metadata: { name: "reddex", namespace: "default" },
    spec: { rules: [{ host: "reddex.app", http: { paths: [{ backend: { service: { name: "reddex-svc" } } }] } }] },
  },
};

beforeEach(() => {
  useCluster.setState({ resources: { deployments, services, ingresses } });
});

function renderSelect(onPreview = vi.fn()) {
  render(<FailoverSelect onPreview={onPreview} previewPending={false} />);
  return onPreview;
}

describe("FailoverSelect", () => {
  it("lists app workloads and hides cluster plumbing", () => {
    renderSelect();
    expect(screen.getByLabelText("default/reddex-deploy")).toBeInTheDocument();
    expect(screen.getByLabelText("personal/outline")).toBeInTheDocument();
    expect(screen.queryByLabelText("kube-system/traefik")).not.toBeInTheDocument();
  });

  it("shows the host that reaches a workload, and says when none does", () => {
    renderSelect();
    expect(screen.getByText("deployment · 2 replicas · reddex.app")).toBeInTheDocument();
    // esports-bot and outline both have no Ingress
    expect(screen.getAllByText("deployment · 1 replica · no Ingress, outbound actor")).toHaveLength(2);
  });

  it("will not preview with nothing checked", () => {
    renderSelect();
    expect(screen.getByRole("button", { name: /preview plan/i })).toBeDisabled();
  });

  it("sends a workloads selection for exactly what is checked", () => {
    const onPreview = renderSelect();
    fireEvent.click(screen.getByLabelText("default/reddex-deploy"));
    fireEvent.click(screen.getByLabelText("personal/outline"));
    fireEvent.click(screen.getByRole("button", { name: /preview plan/i }));
    expect(onPreview).toHaveBeenCalledWith({
      kind: "workloads",
      items: [
        { kind: "Deployment", namespace: "default", name: "reddex-deploy" },
        { kind: "Deployment", namespace: "personal", name: "outline" },
      ],
    });
  });

  it("counts the selection", () => {
    renderSelect();
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("default/reddex-deploy"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("unchecks a row that is clicked twice", () => {
    renderSelect();
    const box = screen.getByLabelText("default/reddex-deploy");
    fireEvent.click(box);
    fireEvent.click(box);
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /preview plan/i })).toBeDisabled();
  });

  it("filters by namespace and select-all only takes what is shown", () => {
    const onPreview = renderSelect();
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: "personal" } });
    expect(screen.queryByLabelText("default/reddex-deploy")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /select these/i }));
    fireEvent.click(screen.getByRole("button", { name: /preview plan/i }));
    expect(onPreview).toHaveBeenCalledWith({
      kind: "workloads",
      items: [{ kind: "Deployment", namespace: "personal", name: "outline" }],
    });
  });

  it("filters by search", () => {
    renderSelect();
    fireEvent.change(screen.getByLabelText("Search workloads"), { target: { value: "esports" } });
    expect(screen.getByLabelText("default/esports-bot")).toBeInTheDocument();
    expect(screen.queryByLabelText("default/reddex-deploy")).not.toBeInTheDocument();
  });

  it("says so when the cluster has no candidates", () => {
    useCluster.setState({ resources: {} });
    renderSelect();
    expect(screen.getByText(/no deployments or statefulsets outside cluster plumbing/i)).toBeInTheDocument();
  });
});
