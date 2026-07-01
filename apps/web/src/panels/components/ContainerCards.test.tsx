// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContainerCards, summarizeContainers } from "./ContainerCards";

describe("summarizeContainers", () => {
  it("maps raw containers to summaries with resource req/lim", () => {
    const out = summarizeContainers([
      {
        name: "web",
        image: "nginx:1.27",
        ports: [{ containerPort: 80 }],
        resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "500m", memory: "128Mi" } },
      },
    ]);
    expect(out).toEqual([
      { name: "web", image: "nginx:1.27", ports: [80], cpuReq: "100m", cpuLim: "500m", memReq: "64Mi", memLim: "128Mi" },
    ]);
  });

  it("defaults a missing image to a dash and drops undefined ports", () => {
    const out = summarizeContainers([{ name: "c", ports: [{}] }]);
    expect(out[0].image).toBe("—");
    expect(out[0].ports).toEqual([]);
  });

  it("returns an empty array for undefined input", () => {
    expect(summarizeContainers(undefined)).toEqual([]);
  });
});

describe("ContainerCards", () => {
  it("renders a card per container with image and ports", () => {
    render(
      <ContainerCards
        containers={[{ name: "web", image: "nginx:1.27", ports: [80, 443] }]}
      />,
    );
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("nginx:1.27")).toBeTruthy();
    expect(screen.getByText(":80 :443")).toBeTruthy();
  });

  it("renders nothing when there are no containers", () => {
    const { container } = render(<ContainerCards containers={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
