// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ throws }: { throws: boolean }): React.ReactElement {
  if (throws) throw new Error("kaboom");
  return <div>alive</div>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("alive")).toBeTruthy();
  });

  it("catches a render throw instead of unmounting the tree", () => {
    render(
      <ErrorBoundary>
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Rigel hit an unexpected error")).toBeTruthy();
    expect(screen.getByText(/kaboom/)).toBeTruthy();
  });

  it("uses a custom fallback and lets it reset the subtree", async () => {
    const { userEvent } = await import("@testing-library/user-event");
    function Harness() {
      const [throws, setThrows] = useState(true);
      return (
        <ErrorBoundary
          fallback={(_error, reset) => (
            <button
              type="button"
              onClick={() => {
                setThrows(false);
                reset();
              }}
            >
              retry
            </button>
          )}
        >
          <Boom throws={throws} />
        </ErrorBoundary>
      );
    }
    render(<Harness />);
    await userEvent.setup().click(screen.getByText("retry"));
    expect(screen.getByText("alive")).toBeTruthy();
  });
});
