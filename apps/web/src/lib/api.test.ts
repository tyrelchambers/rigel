import { afterEach, describe, expect, test, vi } from "vitest";
import { applyManifestYaml, fetchRecentDeploys, undoDeploy } from "./api";

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

describe("recent deploys api", () => {
  test("fetchRecentDeploys GETs the recent endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ batches: [] }), { status: 200 }));
    expect(await fetchRecentDeploys()).toEqual({ batches: [] });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/deployments/recent");
  });

  test("undoDeploy POSTs the batchId + ledger namespace", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 }));
    await undoDeploy("b1", "shop");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/deployments/undo");
    expect(JSON.parse(init!.body as string)).toEqual({ batchId: "b1", namespace: "shop" });
  });
});
