// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { KindAccessNotice } from "./KindAccessNotice";

afterEach(cleanup);

it("shows a no-access message for a forbidden kind", () => {
  render(<KindAccessNotice kind="secrets" access={{ status: "forbidden" }} />);
  expect(screen.getByText(/no access to secrets/i)).toBeInTheDocument();
});

it("renders nothing when access is ok or undefined", () => {
  const { container } = render(<KindAccessNotice kind="pods" access={{ status: "ok" }} />);
  expect(container).toBeEmptyDOMElement();
});
