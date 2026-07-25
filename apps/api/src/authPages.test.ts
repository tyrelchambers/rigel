import { test, expect } from "vitest";
import {
  renderConfirmPage,
  renderConfirmedPage,
  renderDeniedPage,
  renderInvalidPage,
  renderRevokePage,
  renderRevokedPage,
} from "./authPages";

test("the confirm page shows the code and both actions", () => {
  const html = renderConfirmPage("tok-123", "jane@acme.com", "4K7Q-9WXZ");
  expect(html).toContain("4K7Q-9WXZ");
  expect(html).toContain("jane@acme.com");
  expect(html).toContain('value="tok-123"');
  expect(html).toContain('value="confirm"');
  expect(html).toContain('value="deny"');
  expect(html).toContain("It matches, sign me in");
  expect(html).toContain("I didn't start this");
});

test("the confirm page never claims the user initiated the request", () => {
  const html = renderConfirmPage("tok-123", "jane@acme.com", "4K7Q-9WXZ").toLowerCase();
  expect(html).not.toContain("you asked");
  expect(html).not.toContain("you requested");
  expect(html).toContain("if you didn't start this");
});

test("every interpolated value is escaped", () => {
  const html = renderConfirmPage('"><script>alert(1)</script>', '"><b>x</b>', '"><i>y</i>');
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toContain("<b>x</b>");
  expect(html).not.toContain("<i>y</i>");
});

test("the denied page rejects and offers no form", () => {
  const html = renderDeniedPage();
  expect(html).not.toContain("<form");
  expect(html.toLowerCase()).toContain("close this tab");
});

test("the confirmed page names the account", () => {
  expect(renderConfirmedPage("jane@acme.com")).toContain("jane@acme.com");
});

test("the invalid page explains expiry and offers no form", () => {
  const html = renderInvalidPage();
  expect(html).not.toContain("<form");
  expect(html.toLowerCase()).toContain("expired");
});

test("the revoke page posts the token back and styles the action as destructive", () => {
  const html = renderRevokePage("rvk-123");
  expect(html).toContain('action="/auth/revoke"');
  expect(html).toContain('method="post"');
  expect(html).toContain('value="rvk-123"');
  expect(html).toContain("Sign out all devices");
  expect(html).toContain('class="destructive"');
  expect(html).not.toContain('class="primary"');
  expect(renderConfirmPage("t", "a@b.co", "CODE")).not.toContain('class="destructive"');
});

test("the revoke page escapes the token it echoes back", () => {
  const html = renderRevokePage('"><script>alert(1)</script>');
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&quot;&gt;&lt;script&gt;");
});

test("the revoked page reports how many sessions ended, pluralised, with no form", () => {
  const none = renderRevokedPage(0);
  expect(none).not.toContain("<form");
  expect(none.toLowerCase()).toContain("no other active sessions");
  expect(none).not.toContain("0 device");

  const one = renderRevokedPage(1);
  expect(one).not.toContain("<form");
  expect(one).toContain("1 device");
  expect(one).not.toContain("1 devices");

  const two = renderRevokedPage(2);
  expect(two).not.toContain("<form");
  expect(two).toContain("2 devices");
});
