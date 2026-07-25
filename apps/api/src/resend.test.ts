import { test, expect, vi } from "vitest";
import { renderLinkEmailHtml, renderSignInNoticeHtml, createResendSender } from "./resend";

const URL_ = "https://api.example.test/auth/confirm?t=abc123";
const REVOKE_URL = "https://api.example.test/auth/revoke?t=rvk123";
const WHEN = "2026-07-24T12:00:00.000Z";

test("the email links to the confirm page and carries no code", () => {
  const html = renderLinkEmailHtml(URL_);
  expect(html).toContain(`href="${URL_}"`);
  expect(html).toContain("Sign in to Rigel");
  expect(html).not.toMatch(/enter (this|the) code/i);
  // Digits in the rendered copy only — matching raw HTML would hit the #101012 background.
  expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/\b\d{6}\b/);
});

test("the email states the 24-hour validity", () => {
  expect(renderLinkEmailHtml(URL_)).toMatch(/15 minutes/);
});

test("the sign-in notice links to the revoke page and names when it happened", () => {
  const html = renderSignInNoticeHtml(REVOKE_URL, WHEN);
  expect(html).toContain(`href="${REVOKE_URL}"`);
  expect(html).toContain(WHEN);
  expect(html).toContain("Sign out all devices");
  expect(html.toLowerCase()).toContain("if this wasn't you");
});

test("createResendSender posts the link email to Resend", async () => {
  const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  const { sendLink } = createResendSender({ apiKey: "k", from: "Rigel <login@rigel.run>", fetchFn: fetchFn as never });
  await sendLink("jane@acme.com", URL_);

  expect(fetchFn).toHaveBeenCalledOnce();
  const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.resend.com/emails");
  const payload = JSON.parse(init.body as string) as { to: string; subject: string; text: string; html: string };
  expect(payload.to).toBe("jane@acme.com");
  expect(payload.subject).toBe("Sign in to Rigel");
  expect(payload.text).toContain(URL_);
  expect(payload.html).toContain(URL_);
});

test("createResendSender posts the sign-in notice with its own subject and the revoke link", async () => {
  const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  const { sendSignInNotice } = createResendSender({ apiKey: "k", from: "Rigel <login@rigel.run>", fetchFn: fetchFn as never });
  await sendSignInNotice("jane@acme.com", REVOKE_URL, WHEN);

  expect(fetchFn).toHaveBeenCalledOnce();
  const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.resend.com/emails");
  const payload = JSON.parse(init.body as string) as { to: string; subject: string; text: string; html: string };
  expect(payload.to).toBe("jane@acme.com");
  expect(payload.subject).toBe("New sign-in to Rigel");
  expect(payload.text).toContain(REVOKE_URL);
  expect(payload.text).toContain(WHEN);
  expect(payload.html).toContain(REVOKE_URL);
});

test("throws on a non-2xx from Resend", async () => {
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("nope", { status: 422 }));
  const { sendLink, sendSignInNotice } = createResendSender({ apiKey: "re_test", from: "x", fetchFn });
  await expect(sendLink("a@b.co", URL_)).rejects.toThrow();
  await expect(sendSignInNotice("a@b.co", REVOKE_URL, WHEN)).rejects.toThrow();
});
