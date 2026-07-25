export interface ResendConfig {
  apiKey: string;
  from: string;
  fetchFn?: typeof fetch;
}

/** Branded HTML for the sign-in link email. Email-safe: table layout, inline
 *  CSS, system fonts, no external assets. Mirrors the app's login card. */
export function renderLinkEmailHtml(confirmUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
</head>
<body style="margin:0;padding:0;background:#0c0d0f;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">Confirm your Rigel sign-in. This link works for 15 minutes.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0c0d0f;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:100%;background:#101012;border:1px solid rgba(255,255,255,0.10);border-radius:16px;">
<tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="margin:0 0 22px;">
<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#38bdf8;vertical-align:middle;"></span>
<span style="display:inline-block;margin-left:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600;letter-spacing:1.5px;color:#38bdf8;vertical-align:middle;">RIGEL</span>
</div>
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">Sign in to Rigel</h1>
<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#a1a1aa;">Click the button to confirm. Rigel signs itself in, so there is nothing to copy back.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
<tr><td align="center">
<a href="${confirmUrl}" style="display:inline-block;background:#38bdf8;color:#04232e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;line-height:1;text-decoration:none;padding:13px 24px;border-radius:8px;">Confirm sign-in</a>
</td></tr>
</table>
<p style="margin:0 0 4px;font-size:13px;line-height:1.5;color:#8c8c95;">This link works for 15 minutes and can only be used once.</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b6b73;">If you didn't request this, you can safely ignore this email.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Branded HTML for the "a new device signed in" notice, whose only action is
 *  revoking every session. Same email-safe shell as the sign-in link email. */
export function renderSignInNoticeHtml(revokeUrl: string, when: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
</head>
<body style="margin:0;padding:0;background:#0c0d0f;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">A new device signed in to Rigel. If it wasn't you, sign out all devices.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0c0d0f;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:100%;background:#101012;border:1px solid rgba(255,255,255,0.10);border-radius:16px;">
<tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="margin:0 0 22px;">
<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#38bdf8;vertical-align:middle;"></span>
<span style="display:inline-block;margin-left:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600;letter-spacing:1.5px;color:#38bdf8;vertical-align:middle;">RIGEL</span>
</div>
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">New sign-in to Rigel</h1>
<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#a1a1aa;">A new device just signed in to your Rigel account.</p>
<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#e4e4e7;">When: ${when}</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#a1a1aa;">If this wasn't you, sign out every device now. You can sign in again any time.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
<tr><td align="center">
<a href="${revokeUrl}" style="display:inline-block;background:#dc2626;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;line-height:1;text-decoration:none;padding:13px 24px;border-radius:8px;">Sign out all devices</a>
</td></tr>
</table>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b6b73;">If it was you, there is nothing to do.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Resend-backed senders for the two transactional emails, sharing one POST. */
export function createResendSender({ apiKey, from, fetchFn = fetch }: ResendConfig) {
  async function post(email: string, subject: string, text: string, html: string): Promise<void> {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: email, subject, text, html }),
    });
    if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return {
    sendLink: (email: string, confirmUrl: string) =>
      post(
        email,
        "Sign in to Rigel",
        `Confirm your Rigel sign-in: ${confirmUrl}\n\nThe link works for 15 minutes and can only be used once.\n\nIf you did not request this, ignore this email.`,
        renderLinkEmailHtml(confirmUrl),
      ),
    sendSignInNotice: (email: string, revokeUrl: string, when: string) =>
      post(
        email,
        "New sign-in to Rigel",
        `A new device signed in to your Rigel account at ${when}.\n\nIf this wasn't you, sign out every device: ${revokeUrl}\n\nIf it was you, there is nothing to do.`,
        renderSignInNoticeHtml(revokeUrl, when),
      ),
  };
}
