import { test, expect } from "vitest";
import {
  renderConfirmPage,
  renderConfirmedPage,
  renderDeniedPage,
  renderInvalidPage,
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

