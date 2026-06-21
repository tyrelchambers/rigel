import { test, expect } from "vitest";
import { tileInitials } from "./clusterTile";

test("tileInitials takes the first two alphanumeric-run initials, uppercased", () => {
  expect(tileInitials("prod-eks")).toBe("PE");
  expect(tileInitials("home_k3s")).toBe("HK");
  expect(tileInitials("staging")).toBe("ST");
  expect(tileInitials("a")).toBe("A");
});

test("tileInitials falls back to '?' for an empty/odd name", () => {
  expect(tileInitials("")).toBe("?");
  expect(tileInitials("---")).toBe("?");
});
