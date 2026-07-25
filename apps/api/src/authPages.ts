const STYLE = `
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body {
    margin: 0; min-height: 100vh; padding: 32px;
    display: grid; place-items: center;
    background: #07080A; color: #E7E7EA;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    width: 100%; max-width: 520px; padding: 32px;
    background: #1B1C1F; border: 1px solid #34353A; border-radius: 18px;
    box-shadow: 0 30px 80px rgba(0,0,0,.6);
  }
  .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 26px }
  .brand i { width: 9px; height: 9px; border-radius: 50%; background: #38BDF8 }
  .brand span {
    color: #38BDF8; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; font-weight: 600; letter-spacing: .22em;
  }
  h1 { margin: 0 0 12px; font-size: 21px; font-weight: 600; letter-spacing: -.01em }
  p { margin: 0 0 16px; color: #A9AAB1 }
  strong { color: #E7E7EA; font-weight: 600 }
  .code {
    margin: 22px 0; padding: 18px 12px; text-align: center;
    background: #121316; border: 1px solid #34353A; border-radius: 12px;
    color: #38BDF8; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 32px; font-weight: 600; letter-spacing: .18em;
  }
  .warn { color: #A9AAB1 }
  form { margin: 0 }
  form + form { margin-top: 10px }
  button {
    width: 100%; padding: 12px 16px; border-radius: 10px; cursor: pointer;
    font-family: inherit; font-size: 15px; font-weight: 600;
  }
  .primary { background: #38BDF8; border: 1px solid #38BDF8; color: #07080A }
  .secondary { background: transparent; border: 1px solid #34353A; color: #A9AAB1 }
`;

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<style>${STYLE}</style>
<div class="card">
<div class="brand"><i></i><span>RIGEL</span></div>
${body}
</div>`;
}

/** The device-flow confirmation screen. Shows the code the app should also be
 *  displaying so the human can match the two, and never asserts that the human
 *  started the request, because the server cannot know that. */
export function renderConfirmPage(confirmToken: string, email: string, displayCode: string): string {
  const t = esc(confirmToken);
  return shell(
    "Sign in to Rigel",
    `<h1>Sign in to Rigel</h1>
<p>A Rigel app is asking to sign in as <strong>${esc(email)}</strong>. It should be showing this code:</p>
<div class="code">${esc(displayCode)}</div>
<p class="warn">If you didn't start this, or the code doesn't match, don't confirm.</p>
<form method="post" action="/auth/confirm">
<input type="hidden" name="t" value="${t}">
<input type="hidden" name="action" value="confirm">
<button class="primary" type="submit">It matches, sign me in</button>
</form>
<form method="post" action="/auth/confirm">
<input type="hidden" name="t" value="${t}">
<input type="hidden" name="action" value="deny">
<button class="secondary" type="submit">I didn't start this</button>
</form>`,
  );
}

/** Shown after a successful confirm, so the human knows to return to the app. */
export function renderConfirmedPage(email: string): string {
  return shell(
    "You're all set",
    `<h1>You're all set</h1>
<p>Head back to Rigel to finish signing in as <strong>${esc(email)}</strong>.</p>`,
  );
}

/** Shown after an explicit deny, which also invalidates the pending login. */
export function renderDeniedPage(): string {
  return shell(
    "Request rejected",
    `<h1>Request rejected</h1>
<p>Nothing was signed in, and the sign-in request has been cancelled. It is safe to close this tab.</p>`,
  );
}

/** Shown for a link that is unknown, already used, or past its 15 minute life. */
export function renderInvalidPage(): string {
  return shell(
    "Link no longer valid",
    `<h1>Link no longer valid</h1>
<p>This sign-in link has expired or has already been used. Start again from the Rigel app to get a fresh one.</p>`,
  );
}
