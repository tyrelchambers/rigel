// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const matrixLogin = vi.fn(async () => ({ accessToken: "tok-login", userId: "@rigel:hs" }));
const matrixValidate = vi.fn(async () => ({ userId: "@rigel:hs" }));
const matrixCreateRoom = vi.fn(async () => ({ roomId: "!room:hs" }));
const matrixPoll = vi.fn(async () => ({ userMessaged: false, botReplied: false }));
const matrixSendTest = vi.fn(async () => ({ ok: true as const }));
const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
vi.mock("@/lib/api", () => ({
  matrixLogin: (...a: unknown[]) => matrixLogin(...(a as [])),
  matrixValidate: (...a: unknown[]) => matrixValidate(...(a as [])),
  matrixCreateRoom: (...a: unknown[]) => matrixCreateRoom(...(a as [])),
  matrixPoll: (...a: unknown[]) => matrixPoll(...(a as [])),
  matrixSendTest: (...a: unknown[]) => matrixSendTest(...(a as [])),
  useAssistantAction: () => ({ mutateAsync, isPending: false }),
}));

import { MatrixConnectModal } from "./MatrixConnectModal";

beforeEach(() => {
  matrixLogin.mockClear();
  matrixValidate.mockClear();
  matrixCreateRoom.mockClear();
  matrixPoll.mockClear();
  matrixSendTest.mockClear();
  mutateAsync.mockClear();
});

function open(allowed = "@me:hs") {
  render(<MatrixConnectModal open onClose={() => {}} namespace="default" defaultAllowed={allowed} />);
}

const click = (re: RegExp) => fireEvent.click(screen.getByRole("button", { name: re }));
/** Step 1: select a where-option card, then advance with Continue → step 2. */
function chooseAndContinue(card: RegExp) {
  click(card);
  click(/^continue$/i);
}

describe("MatrixConnectModal", () => {
  it("path A + login: logs in, creates a room, saves via setMatrix", async () => {
    open();
    chooseAndContinue(/already have a homeserver/i);
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
    click(/^log in$/i); // segmented → login mode
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "rigel" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "pw" } });
    click(/^continue$/i); // step-2 primary triggers connect()

    await waitFor(() => expect(matrixLogin).toHaveBeenCalledWith("https://hs", "rigel", "pw"));
    expect(matrixValidate).not.toHaveBeenCalled();
    await waitFor(() => expect(matrixCreateRoom).toHaveBeenCalledWith("https://hs", "tok-login", "Rigel", ["@me:hs"]));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setMatrix",
        namespace: "default",
        matrixHomeserverUrl: "https://hs",
        matrixUserId: "@rigel:hs",
        matrixAccessToken: "tok-login",
        matrixRoomId: "!room:hs",
        matrixAllowedSenders: "@me:hs",
        matrixInbound: true,
      }),
    );
  });

  it("path A + token: validates the pasted token instead of logging in", async () => {
    open();
    chooseAndContinue(/already have a homeserver/i);
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
    // token mode is the default for path A
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: "tok-paste" } });
    click(/^continue$/i);

    await waitFor(() => expect(matrixValidate).toHaveBeenCalledWith("https://hs", "tok-paste"));
    expect(matrixLogin).not.toHaveBeenCalled();
    await waitFor(() => expect(matrixCreateRoom).toHaveBeenCalledWith("https://hs", "tok-paste", "Rigel", ["@me:hs"]));
  });

  it("disables Continue and fires no API calls when allowed-senders is empty", () => {
    open("");
    chooseAndContinue(/already have a homeserver/i);
    // No allowed senders — the step-2 Continue must be disabled.
    const continueBtn = screen.getByRole("button", { name: /^continue$/i });
    expect(continueBtn).toBeDisabled();
    fireEvent.click(continueBtn);
    // None of the API calls should have fired.
    expect(matrixValidate).not.toHaveBeenCalled();
    expect(matrixLogin).not.toHaveBeenCalled();
    expect(matrixCreateRoom).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("path B prefills matrix.org and shows the privacy caveat", () => {
    open();
    chooseAndContinue(/public homeserver/i);
    expect((screen.getByLabelText(/homeserver/i) as HTMLInputElement).value).toBe("https://matrix.org");
    expect(screen.getByText(/isn't private to you/i)).toBeInTheDocument();
  });

  it("credentials step (path A) shows the Read the guide link pointing at the access-token guide", () => {
    open();
    chooseAndContinue(/already have a homeserver/i);
    const link = screen.getByRole("link", { name: /read the guide/i });
    expect(link).toHaveAttribute(
      "href",
      "https://outline.tybit.luxe/doc/matrix-access-tokens-bot-accounts-for-the-rigel-assistant-UKyuTZRbBw",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("credentials step (path B) also shows the Read the guide link", () => {
    open();
    chooseAndContinue(/public homeserver/i);
    const link = screen.getByRole("link", { name: /read the guide/i });
    expect(link).toHaveAttribute(
      "href",
      "https://outline.tybit.luxe/doc/matrix-access-tokens-bot-accounts-for-the-rigel-assistant-UKyuTZRbBw",
    );
  });

  it("poll loop advances the tracker as poll results change, then stops", async () => {
    vi.useFakeTimers();
    try {
      // First tick: user messaged; second tick: bot replied.
      matrixPoll
        .mockResolvedValueOnce({ userMessaged: true, botReplied: false })
        .mockResolvedValueOnce({ userMessaged: true, botReplied: true });

      open();
      chooseAndContinue(/already have a homeserver/i);
      fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
      fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: "tok-paste" } });
      click(/^continue$/i);

      // connect() runs async; flush microtasks so we land on firstContact.
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText(/say hello to rigel/i)).toBeInTheDocument();
      // Row 1 starts live (badge present).
      expect(screen.getByText("Live")).toBeInTheDocument();

      // First poll tick → userMessaged=true: "Live" badge clears.
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
      expect(matrixPoll).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Live")).not.toBeInTheDocument();

      // Second poll tick → botReplied=true: poll stops, no spinners remain.
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
      expect(matrixPoll).toHaveBeenCalledTimes(2);
      expect(document.querySelector(".animate-spin")).toBeNull();

      // Further time passes — poll does NOT fire again (loop stopped on botReplied).
      await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
      expect(matrixPoll).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the generic unreachable message (not tailnet-specific) when the homeserver does not respond", async () => {
    matrixValidate.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND hs.example.com"));
    open();
    chooseAndContinue(/already have a homeserver/i);
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs.example.com" } });
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: "tok" } });
    click(/^continue$/i);
    await waitFor(() =>
      expect(screen.getByText(/reachable from this machine/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/tailnet/i)).not.toBeInTheDocument();
  });

  it("advances to first-contact view after a successful connect, not back to step 1", async () => {
    open();
    chooseAndContinue(/already have a homeserver/i);
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: "tok" } });
    click(/^continue$/i);
    await waitFor(() =>
      expect(screen.getByText(/say hello to rigel/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/where should rigel's matrix live/i)).not.toBeInTheDocument();
  });

  it("the firstContact 'Send a test' button calls matrixSendTest with the connected room", async () => {
    open();
    chooseAndContinue(/already have a homeserver/i);
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: "tok-paste" } });
    click(/^continue$/i);

    await waitFor(() => expect(screen.getByText(/say hello to rigel/i)).toBeInTheDocument());

    click(/send a test message from rigel/i);
    await waitFor(() =>
      expect(matrixSendTest).toHaveBeenCalledWith({
        homeserver: "https://hs",
        accessToken: "tok-paste",
        roomId: "!room:hs",
      }),
    );
  });
});
