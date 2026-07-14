export interface ResendConfig {
  apiKey: string;
  from: string;
  fetchFn?: typeof fetch;
}

/** Branded HTML for the sign-in code email. Email-safe: table layout, inline
 *  CSS, system fonts, no external assets. Mirrors the app's login card. */
export function renderCodeEmailHtml(code: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
</head>
<body style="margin:0;padding:0;background:#0c0d0f;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">Your Rigel sign-in code: ${code} — expires in 10 minutes.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0c0d0f;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:100%;background:#101012;border:1px solid rgba(255,255,255,0.10);border-radius:16px;">
<tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="margin:0 0 22px;">
<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#38bdf8;vertical-align:middle;"></span>
<span style="display:inline-block;margin-left:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600;letter-spacing:1.5px;color:#38bdf8;vertical-align:middle;">RIGEL</span>
</div>
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">Sign in to Rigel</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#a1a1aa;">Enter this code to finish signing in.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;background:#0c0d0f;border:1px solid rgba(255,255,255,0.10);border-radius:10px;">
<tr><td align="center" style="padding:18px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:600;letter-spacing:10px;color:#ffffff;">${code}</td></tr>
</table>
<p style="margin:0 0 4px;font-size:13px;line-height:1.5;color:#8c8c95;">This code expires in 10 minutes.</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b6b73;">If you didn't request this, you can safely ignore this email.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
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
        subject: "Your Rigel sign-in code",
        text: `Your Rigel sign-in code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
        html: renderCodeEmailHtml(code),
      }),
    });
    if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text().catch(() => "")}`);
  };
}
