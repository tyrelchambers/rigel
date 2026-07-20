// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ConfirmSheet } from "./ConfirmSheet";
import type { ActionBlock } from "@/lib/api";

// The sheet fires network reads (preview command, contexts) on open; stub fetch
// so they resolve harmlessly — the notice renders regardless of those.
vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

afterEach(cleanup);

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const action: ActionBlock = {
  kind: "setImage",
  label: "Update nextcloud to 34.0.1-apache",
  name: "nextcloud",
  namespace: "default",
  resourceKind: "deployment",
  container: "nextcloud",
  image: "nextcloud:34.0.1-apache",
};

test("renders the major-upgrade notice when provided", () => {
  wrap(
    <ConfirmSheet
      action={action}
      notice="Major version jump (v29 → v34). Review this app's upgrade notes before continuing."
      open
      onClose={() => {}}
    />,
  );
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(/major version jump \(v29 → v34\)/i);
});

test("no alert when notice is absent", () => {
  wrap(<ConfirmSheet action={action} open onClose={() => {}} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
