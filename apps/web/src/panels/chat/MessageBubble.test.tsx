// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "./types";

afterEach(cleanup);

// SuggestedAlertList uses useAssistantAction — mock to avoid a QueryClient provider.
vi.mock("@/lib/api", () => ({
  useAssistantAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  writeText.mockClear();
});

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "test-id",
    role: "assistant",
    text: "",
    ...overrides,
  };
}

const noop = () => {};

describe("MessageBubble code block copy button", () => {
  test("fenced code block renders a Copy button", () => {
    const msg = makeMessage({ text: "```\nkubectl get pods\n```" });
    render(
      <MessageBubble
        message={msg}
        onAction={noop}
        onRunBatch={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /copy code/i })).toBeDefined();
  });

  test("clicking Copy calls writeText with the code text", async () => {
    const msg = makeMessage({ text: "```\nkubectl get pods\n```" });
    render(
      <MessageBubble
        message={msg}
        onAction={noop}
        onRunBatch={noop}
        onAnswer={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy code/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("kubectl get pods");
    });
  });

  test("copy button flips to Copied after click", async () => {
    const msg = makeMessage({ text: "```\nkubectl get pods\n```" });
    render(
      <MessageBubble
        message={msg}
        onAction={noop}
        onRunBatch={noop}
        onAnswer={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy code/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copied/i })).toBeDefined();
    });
  });

  test("inline code renders NO copy button", () => {
    const msg = makeMessage({ text: "use `kubectl` here" });
    render(
      <MessageBubble
        message={msg}
        onAction={noop}
        onRunBatch={noop}
        onAnswer={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });
});
