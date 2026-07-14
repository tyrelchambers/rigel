import { test, expect, vi } from "vitest";
import { createResendSender } from "./resend";

test("posts the code to Resend and resolves on 200", async () => {
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "x" }), { status: 200 }));
  const send = createResendSender({ apiKey: "re_test", from: "Rigel <login@rigel.run>", fetchFn });
  await send("jane@acme.com", "123456");
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.resend.com/emails");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
  const payload = JSON.parse(init.body as string);
  expect(payload.to).toBe("jane@acme.com");
  expect(payload.from).toBe("Rigel <login@rigel.run>");
  // Code is NOT in the subject (keeps it off lock-screen/notification previews).
  expect(payload.subject).toBe("Your Rigel sign-in code");
  expect(payload.subject).not.toContain("123456");
  // Both the plaintext fallback and the branded HTML carry the code.
  expect(payload.text).toContain("123456");
  expect(payload.html).toContain("123456");
  expect(payload.html).toContain("RIGEL");
});

test("throws on a non-2xx from Resend", async () => {
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("nope", { status: 422 }));
  const send = createResendSender({ apiKey: "re_test", from: "x", fetchFn });
  await expect(send("a@b.co", "000000")).rejects.toThrow();
});
