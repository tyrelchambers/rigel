// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// vi.mock is hoisted above top-level consts, so the mock fn must be created via
// vi.hoisted() (or be `mock`-prefixed) or vitest 4 throws "Cannot access
// 'submitSignup' before initialization". Assertions below are unchanged.
const { submitSignup } = vi.hoisted(() => ({ submitSignup: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("@/lib/desktop", () => ({ rigel: { submitSignup }, isDesktop: true }));

import { AccountGate } from "./AccountGate";

afterEach(() => { cleanup(); submitSignup.mockClear(); });

test("renders the welcome form, captures name+email, then calls onDone", async () => {
  const onDone = vi.fn();
  render(<AccountGate onDone={onDone} />);
  expect(screen.getByText("Welcome to Rigel")).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Jane" } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "jane@acme.com" } });
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  await waitFor(() => expect(submitSignup).toHaveBeenCalledWith({ name: "Jane", email: "jane@acme.com" }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});
