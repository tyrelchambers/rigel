// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FailoverRunning } from "./FailoverRunning";
import type { FailoverJobView } from "@/lib/api";

const job = (over: Partial<FailoverJobView> = {}): FailoverJobView => ({
  status: "running",
  steps: [
    { id: "provision", label: "Provision DOKS", status: "done", detail: "do-tor1-x" },
    { id: "stack", label: "Install stack", status: "done", detail: "cert-manager, cloudnative-pg, traefik" },
    { id: "rewrite", label: "Rewrite endpoints", status: "running", detail: "3 values repointed" },
    { id: "apply", label: "Apply closure", status: "pending" },
  ],
  ...over,
});

describe("FailoverRunning", () => {
  it("renders nothing before a run has ever started", () => {
    const { container } = render(<FailoverRunning job={{ status: "idle", steps: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows every step with its detail", () => {
    render(<FailoverRunning job={job()} />);
    expect(screen.getByText("Provision DOKS")).toBeInTheDocument();
    expect(screen.getByText("do-tor1-x")).toBeInTheDocument();
    expect(screen.getByText("Apply closure")).toBeInTheDocument();
  });

  it("counts finished steps, treating skipped as settled", () => {
    render(
      <FailoverRunning
        job={job({
          steps: [
            { id: "a", label: "A", status: "done" },
            { id: "b", label: "B", status: "skipped" },
            { id: "c", label: "C", status: "running" },
            { id: "d", label: "D", status: "pending" },
          ],
        })}
      />,
    );
    expect(screen.getByText("2/4")).toBeInTheDocument();
  });

  it("marks the running step with a spinner", () => {
    render(<FailoverRunning job={job()} />);
    expect(screen.getByLabelText("running")).toBeInTheDocument();
  });

  it("says Copy is up when the run finished", () => {
    render(<FailoverRunning job={job({ status: "done" })} />);
    expect(screen.getByText("Copy is up")).toBeInTheDocument();
  });

  it("surfaces the failure and the step that failed", () => {
    render(
      <FailoverRunning
        job={job({
          status: "failed",
          error: "apply rejected the bundle",
          steps: [{ id: "apply", label: "Apply closure", status: "failed", error: "no such storage class" }],
        })}
      />,
    );
    expect(screen.getByText("Run failed")).toBeInTheDocument();
    expect(screen.getByText("apply rejected the bundle")).toBeInTheDocument();
    expect(screen.getByText("no such storage class")).toBeInTheDocument();
  });

  it("promises dump bytes never reach the UI", () => {
    render(<FailoverRunning job={job()} />);
    expect(screen.getByText(/dump bytes stay on this machine/i)).toBeInTheDocument();
  });

  it("shows a run that was lost to an app restart", () => {
    render(
      <FailoverRunning
        job={job({
          status: "failed",
          error:
            "The app restarted while this run was in flight. Check the destination for a cluster that was left behind.",
          steps: [
            { id: "provision", label: "Provision DOKS", status: "done", detail: "do-tor1-x" },
            { id: "apply", label: "Apply closure", status: "failed" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Run failed")).toBeInTheDocument();
    expect(screen.getByText(/cluster that was left behind/i)).toBeInTheDocument();
    expect(screen.getByText("do-tor1-x")).toBeInTheDocument();
  });
});
