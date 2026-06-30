// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LinkRepoModal } from "./LinkRepoModal";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

let linkOk = true;
let lastLinkBody: Record<string, unknown> | null = null;

beforeEach(() => {
  linkOk = true;
  lastLinkBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/git/link")) {
        lastLinkBody = JSON.parse((init?.body as string) ?? "{}");
        if (!linkOk) return new Response(JSON.stringify({ error: "repo not found" }), { status: 500 });
        return new Response(
          JSON.stringify({
            ok: true,
            source: "canada-hires",
            repo: "tyrel/canada-hires",
            repoName: "canada-hires",
            repoURL: "https://github.com/tyrel/canada-hires",
            branch: "main",
            path: "",
          }),
        );
      }
      return new Response("{}");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function defaults() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    namespace: "default",
    deployment: "canada-hires",
  };
}

describe("LinkRepoModal", () => {
  it("shows the deployment subtitle and keeps submit disabled until a repo URL is entered", async () => {
    wrap(<LinkRepoModal {...defaults()} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/canada-hires · creates a GitOps source/i)).toBeInTheDocument();

    const submit = within(dialog).getByRole("button", { name: /create source & link/i });
    expect(submit).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText(/repository url/i), "https://github.com/tyrel/canada-hires");
    expect(submit).toBeEnabled();
  });

  it("posts the link to /api/git/link and closes on success", async () => {
    const onOpenChange = vi.fn();
    wrap(<LinkRepoModal {...defaults()} onOpenChange={onOpenChange} />);
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText(/repository url/i), "https://github.com/tyrel/canada-hires");
    await userEvent.clear(within(dialog).getByLabelText(/manifest path/i));
    await userEvent.type(within(dialog).getByLabelText(/manifest path/i), "k8s/");
    await userEvent.click(within(dialog).getByRole("button", { name: /create source & link/i }));

    expect(lastLinkBody).toMatchObject({
      namespace: "default",
      deployment: "canada-hires",
      repoURL: "https://github.com/tyrel/canada-hires",
      branch: "main",
      path: "k8s/",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces a link error and stays open", async () => {
    linkOk = false;
    const onOpenChange = vi.fn();
    wrap(<LinkRepoModal {...defaults()} onOpenChange={onOpenChange} />);
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText(/repository url/i), "https://github.com/tyrel/canada-hires");
    await userEvent.click(within(dialog).getByRole("button", { name: /create source & link/i }));

    expect(await within(dialog).findByText(/repo not found/i)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
