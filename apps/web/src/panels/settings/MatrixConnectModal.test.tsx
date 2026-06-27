// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const matrixLogin = vi.fn(async () => ({ accessToken: "tok-login", userId: "@rigel:hs" }));
const matrixValidate = vi.fn(async () => ({ userId: "@rigel:hs" }));
const matrixCreateRoom = vi.fn(async () => ({ roomId: "!room:hs" }));
const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
vi.mock("@/lib/api", () => ({
  matrixLogin: (...a: unknown[]) => matrixLogin(...(a as [])),
  matrixValidate: (...a: unknown[]) => matrixValidate(...(a as [])),
  matrixCreateRoom: (...a: unknown[]) => matrixCreateRoom(...(a as [])),
  useAssistantAction: () => ({ mutateAsync, isPending: false }),
}));

import { MatrixConnectModal } from "./MatrixConnectModal";

beforeEach(() => {
  matrixLogin.mockClear();
  matrixValidate.mockClear();
  matrixCreateRoom.mockClear();
  mutateAsync.mockClear();
});

function open() {
  render(<MatrixConnectModal open onClose={() => {}} namespace="default" defaultAllowed="@me:hs" />);
}

describe("MatrixConnectModal", () => {
  it("path A + login: logs in, creates a room, saves via setMatrix", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /already have a homeserver/i }));
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i })); // switch to login mode
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "rigel" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

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
    fireEvent.click(screen.getByRole("button", { name: /already have a homeserver/i }));
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
    // token mode is the default
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: "tok-paste" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(matrixValidate).toHaveBeenCalledWith("https://hs", "tok-paste"));
    expect(matrixLogin).not.toHaveBeenCalled();
    await waitFor(() => expect(matrixCreateRoom).toHaveBeenCalledWith("https://hs", "tok-paste", "Rigel", ["@me:hs"]));
  });

  it("path B prefills matrix.org and shows the privacy caveat", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /public homeserver/i }));
    expect((screen.getByLabelText(/homeserver/i) as HTMLInputElement).value).toBe("https://matrix.org");
    expect(screen.getByText(/can read/i)).toBeInTheDocument();
  });
});
