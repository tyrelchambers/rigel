// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AboutYouStep } from "./AboutYouStep";

test("Continue is disabled until name + valid email, then submits and advances", async () => {
  const submit = vi.fn().mockResolvedValue({ ok: true });
  const onDone = vi.fn();
  render(<AboutYouStep submitSignup={submit} onDone={onDone} />);

  const cont = screen.getByRole("button", { name: /continue/i });
  expect(cont).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Jane" } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "bad" } });
  expect(cont).toBeDisabled(); // invalid email

  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "jane@acme.com" } });
  expect(cont).toBeEnabled();

  fireEvent.click(cont);
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: "Jane", email: "jane@acme.com" }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

test("pressing Enter in a field submits (Continue) when valid", async () => {
  const submit = vi.fn().mockResolvedValue({ ok: true });
  const onDone = vi.fn();
  render(<AboutYouStep submitSignup={submit} onDone={onDone} />);

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Jane" } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "jane@acme.com" } });

  // Enter inside the form triggers its submit handler (native browser behavior).
  const form = screen.getByLabelText(/email/i).closest("form");
  expect(form).not.toBeNull();
  fireEvent.submit(form!);

  await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: "Jane", email: "jane@acme.com" }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

test("Enter does nothing while the form is invalid", async () => {
  const submit = vi.fn().mockResolvedValue({ ok: true });
  const onDone = vi.fn();
  render(<AboutYouStep submitSignup={submit} onDone={onDone} />);

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Jane" } });
  // email still empty → invalid
  const form = screen.getByLabelText(/email/i).closest("form");
  fireEvent.submit(form!);

  expect(submit).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});
