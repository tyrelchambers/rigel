// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

import { StatefulSetRow } from "./StatefulSetRow";
import { useCluster } from "@/store/cluster";
import type { StatefulSet } from "./types";

beforeEach(() => useCluster.setState({ resources: {} }));

const sts: StatefulSet = {
  metadata: { name: "db", namespace: "prod", uid: "s1" },
  spec: { replicas: 1, serviceName: "db-svc", template: { spec: { containers: [{ name: "pg", image: "postgres:16" }] } } },
  status: { readyReplicas: 1, replicas: 1 },
};

const noop = vi.fn();

function row(isOpen: boolean) {
  return render(
    <MemoryRouter>
      <StatefulSetRow s={sts} k="prod/db" isOpen={isOpen} toggleExpand={noop} askClaude={noop} restartStatefulSet={noop} openScale={noop} deleteStatefulSet={noop} />
    </MemoryRouter>,
  );
}

describe("StatefulSetRow expandedContent", () => {
  it("shows the detail when open", () => {
    row(true);
    expect(screen.getByText("db-svc")).toBeTruthy();
    expect(screen.getByText("postgres:16")).toBeTruthy();
  });

  it("hides the detail when collapsed", () => {
    row(false);
    expect(screen.queryByText("db-svc")).toBeNull();
  });
});
