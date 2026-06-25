import { test, expect } from "vitest";
import { nextStepFromCheck } from "./wizard";

test("missing CLI takes priority", () => {
  expect(nextStepFromCheck({ cliInstalled: false, extraBinariesInstalled: false, authenticated: false }))
    .toBe("needs-cli");
});

test("CLI present but extra binary missing", () => {
  expect(nextStepFromCheck({ cliInstalled: true, extraBinariesInstalled: false, authenticated: false }))
    .toBe("needs-extra");
});

test("CLI + extras present but not logged in", () => {
  expect(nextStepFromCheck({ cliInstalled: true, extraBinariesInstalled: true, authenticated: false }))
    .toBe("needs-login");
});

test("everything ready", () => {
  expect(nextStepFromCheck({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true }))
    .toBe("ready");
});
