// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./NamespaceBar", () => ({ NamespaceSelector: () => null }));
vi.mock("./useNavHistory", () => ({
  useNavHistory: () => ({
    canGoBack: false,
    canGoForward: false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  }),
}));
vi.mock("@/store/cluster", () => ({ useCluster: () => false }));
const voiceProps = vi.hoisted(() => ({ style: undefined as React.CSSProperties | undefined }));
vi.mock("./voice/VoiceControl", () => ({
  VoiceControl: (props: { style?: React.CSSProperties }) => {
    voiceProps.style = props.style;
    return null;
  },
}));

import { GlobalHeader } from "./GlobalHeader";

afterEach(cleanup);

test("shows no Account affordance: local use needs no sign-in", () => {
  render(<GlobalHeader onOpenSearch={vi.fn()} onOpenAccount={vi.fn()} />);
  expect(screen.queryByLabelText("Account")).toBeNull();
});

test("the voice control gets no-drag, or the header would swallow its clicks", () => {
  render(<GlobalHeader onOpenSearch={vi.fn()} onOpenAccount={vi.fn()} />);
  expect(voiceProps.style).toEqual({ WebkitAppRegion: "no-drag" });
});

test("still renders the search button", () => {
  const onOpenSearch = vi.fn();
  render(<GlobalHeader onOpenSearch={onOpenSearch} onOpenAccount={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("Search"));
  expect(onOpenSearch).toHaveBeenCalledTimes(1);
});
