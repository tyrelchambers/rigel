// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { KindAccessNotice } from "./KindAccessNotice";

afterEach(cleanup);

it("shows a no-access message for a forbidden kind", () => {
  render(<KindAccessNotice kind="secrets" access={{ status: "forbidden" }} />);
  expect(screen.getByText("No access to secrets.")).toBeInTheDocument();
});

it("does not mention namespace scoping in the message", () => {
  render(<KindAccessNotice kind="secrets" access={{ status: "forbidden" }} />);
  expect(screen.queryByText(/in this namespace/i)).not.toBeInTheDocument();
});

it("renders nothing when access is ok or undefined", () => {
  const { container } = render(<KindAccessNotice kind="pods" access={{ status: "ok" }} />);
  expect(container).toBeEmptyDOMElement();
});
