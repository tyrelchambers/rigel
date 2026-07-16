import { test, expect } from "vitest";
import { createRateLimiter } from "./rateLimit";

test("allows up to the limit, then blocks, then resets after the window", () => {
  let t = 1000;
  const allow = createRateLimiter(2, 60_000, () => t);
  expect(allow("ip")).toBe(true);
  expect(allow("ip")).toBe(true);
  expect(allow("ip")).toBe(false); // 3rd in window
  t += 60_000;
  expect(allow("ip")).toBe(true); // window reset
});

test("tracks keys independently", () => {
  const allow = createRateLimiter(1, 60_000, () => 0);
  expect(allow("a")).toBe(true);
  expect(allow("b")).toBe(true);
  expect(allow("a")).toBe(false);
});
