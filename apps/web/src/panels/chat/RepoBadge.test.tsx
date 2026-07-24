// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RepoBadge } from "./RepoBadge";

describe("RepoBadge", () => {
  it("labels the badge with the repo slug", () => {
    render(<RepoBadge slug="tyrelchambers/jobwatch-canada" />);
    expect(screen.getByLabelText("tyrelchambers/jobwatch-canada")).toBeInTheDocument();
  });

  it("renders an external link to the PR when href is given", () => {
    render(<RepoBadge slug="tyrelchambers/jobwatch-canada" href="https://github.com/tyrelchambers/jobwatch-canada/pull/42" />);
    const link = screen.getByRole("link", { name: "tyrelchambers/jobwatch-canada" });
    expect(link).toHaveAttribute("href", "https://github.com/tyrelchambers/jobwatch-canada/pull/42");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("is non-interactive (no link) when href is absent", () => {
    render(<RepoBadge slug="tyrelchambers/jobwatch-canada" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("includes the PR number and state in the label and stamps the state", () => {
    render(
      <RepoBadge
        slug="tyrelchambers/jobwatch-canada"
        href="https://github.com/tyrelchambers/jobwatch-canada/pull/42"
        state="merged"
        prNumber={42}
      />,
    );
    const link = screen.getByRole("link", { name: "tyrelchambers/jobwatch-canada #42 · merged" });
    expect(link).toHaveAttribute("data-pr-state", "merged");
  });
});
