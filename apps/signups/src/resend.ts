export interface ResendConfig {
  apiKey: string;
  from: string;
  fetchFn?: typeof fetch;
}

/** Returns a sendCode(email, code) that emails the OTP via Resend. */
export function createResendSender({ apiKey, from, fetchFn = fetch }: ResendConfig) {
  return async function sendCode(email: string, code: string): Promise<void> {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: email,
        subject: `Your Rigel sign-in code: ${code}`,
        text: `Your Rigel sign-in code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
      }),
    });
    if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text().catch(() => "")}`);
  };
}
