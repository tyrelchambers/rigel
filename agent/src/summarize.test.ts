import { describe, expect, test, vi } from "vitest";

const runModelMock = vi.hoisted(() => vi.fn());
vi.mock("./runModel.js", () => ({ runModel: (...a: unknown[]) => runModelMock(...a) }));

import { composeUpdate } from "./summarize.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

const rc = {} as RuntimeConfig;
const lines = ["✓ Restarted canadahires-api so it reconnects to the database"];

describe("composeUpdate", () => {
  test("uses the model's plain summary", async () => {
    runModelMock.mockResolvedValueOnce({ text: "Your API lost its database connection. I restarted it.", isError: false, costUsd: 0 });
    expect(await composeUpdate(rc, lines)).toBe("Your API lost its database connection. I restarted it.");
    expect(runModelMock.mock.lastCall![0].prompt).toContain(lines[0]);
  });

  test("falls back to the plain lines when the model errors", async () => {
    runModelMock.mockResolvedValueOnce({ text: "", isError: true, errorMessage: "timed out", costUsd: 0 });
    expect(await composeUpdate(rc, lines)).toContain(lines[0]);
  });

  test("falls back to the plain lines when the model throws", async () => {
    runModelMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    expect(await composeUpdate(rc, lines)).toContain(lines[0]);
  });
});
