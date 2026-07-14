// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClusterOnboarding } from "./ClusterOnboarding";

vi.mock("../CreateClusterModal", () => ({
  CreateClusterModal: ({ open }: { open: boolean }) => (open ? <div>CREATE OPEN</div> : null),
}));
vi.mock("../ConnectClusterModal", () => ({
  ConnectClusterModal: ({ open }: { open: boolean }) => (open ? <div>CONNECT OPEN</div> : null),
}));
vi.mock("../ImportKubeconfigPanel", () => ({
  ImportKubeconfigPanel: () => <div>IMPORT PANEL</div>,
}));

test("shows the heading and three paths", () => {
  render(<ClusterOnboarding onSkip={vi.fn()} />);
  expect(screen.getByText("Connect a cluster to get started")).toBeTruthy();
  expect(screen.getByText("Create a local cluster")).toBeTruthy();
  expect(screen.getByText("Connect a cloud cluster")).toBeTruthy();
  expect(screen.getByText("Import a kubeconfig")).toBeTruthy();
});

test("clicking a path opens its modal", () => {
  render(<ClusterOnboarding onSkip={vi.fn()} />);
  fireEvent.click(screen.getByText("Create a local cluster"));
  expect(screen.getByText("CREATE OPEN")).toBeTruthy();
});

test("clicking connect opens the connect modal", () => {
  render(<ClusterOnboarding onSkip={vi.fn()} />);
  fireEvent.click(screen.getByText("Connect a cloud cluster"));
  expect(screen.getByText("CONNECT OPEN")).toBeTruthy();
});

test("clicking import opens a dialog with the import panel", () => {
  render(<ClusterOnboarding onSkip={vi.fn()} />);
  expect(screen.queryByText("IMPORT PANEL")).toBeNull();
  fireEvent.click(screen.getByText("Import a kubeconfig"));
  expect(screen.getByText("IMPORT PANEL")).toBeTruthy();
});

test("Skip for now calls onSkip", () => {
  const onSkip = vi.fn();
  render(<ClusterOnboarding onSkip={onSkip} />);
  fireEvent.click(screen.getByText("Skip for now"));
  expect(onSkip).toHaveBeenCalled();
});

test("Learn the basics links out to the kubernetes docs", () => {
  render(<ClusterOnboarding onSkip={vi.fn()} />);
  const link = screen.getByText("Learn the basics") as HTMLAnchorElement;
  expect(link.href).toBe("https://kubernetes.io/docs/tutorials/kubernetes-basics/");
});
