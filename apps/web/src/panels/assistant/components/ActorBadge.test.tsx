// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActorBadge } from "./ActorBadge";

describe("ActorBadge", () => {
  it("renders a desktop approval with its label and icon", () => {
    const { container } = render(<ActorBadge actor="desktop" />);
    expect(screen.getByText("Approved on desktop")).toBeInTheDocument();
    expect(container.querySelector('svg[data-icon="desktop"]')).not.toBeNull();
  });

  it("renders nothing for an unknown actor", () => {
    const { container } = render(<ActorBadge actor="something-else" />);
    expect(container).toBeEmptyDOMElement();
  });
});
