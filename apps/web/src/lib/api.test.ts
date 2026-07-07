import { afterEach, describe, expect, test, vi } from "vitest";
import { applyManifestYaml } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("applyManifestYaml", () => {
  test("includes source in the POST body when provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "" }), { status: 200 }));
    await applyManifestYaml("kind: X", false, "compose-migration");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ yaml: "kind: X", dryRun: false, source: "compose-migration" });
  });

  test("omits source when not provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "" }), { status: 200 }));
    await applyManifestYaml("kind: X", true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ yaml: "kind: X", dryRun: true });
  });
});
