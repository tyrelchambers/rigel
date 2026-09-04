import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FailoverObjectStore } from "@rigel/k8s/src/failover/types";
import { clientFor, validateObjectStore, uploadDir } from "./objectStore";

const spaces: FailoverObjectStore = {
  endpoint: "https://tor1.digitaloceanspaces.com",
  region: "us-east-1",
  bucket: "rigel-failover",
  accessKey: "KEY",
  secretKey: "SECRET",
  addressing: "virtualHost",
};

const garage: FailoverObjectStore = {
  endpoint: "https://garage.default.svc.cluster.local:3900",
  region: "garage",
  bucket: "rigel-failover",
  accessKey: "KEY",
  secretKey: "SECRET",
  addressing: "path",
};

function failing(err: Partial<{ name: string; Code: string; $metadata: { httpStatusCode: number } }> & { message?: string }) {
  return { send: vi.fn().mockRejectedValue(Object.assign(new Error(err.message ?? "boom"), err)) };
}

describe("clientFor", () => {
  it("uses the stored addressing style rather than guessing", () => {
    expect(clientFor(spaces).config.forcePathStyle).toBe(false);
    expect(clientFor(garage).config.forcePathStyle).toBe(true);
  });
});

describe("validateObjectStore", () => {
  it("reports an existing bucket", async () => {
    const s3 = { send: vi.fn().mockResolvedValue({}) };
    expect(await validateObjectStore(spaces, { s3 })).toEqual({
      ok: true,
      bucketExists: true,
      insideSourceCluster: false,
    });
  });

  it("treats a missing bucket as fine, because save creates it", async () => {
    const s3 = failing({ $metadata: { httpStatusCode: 404 } });
    expect(await validateObjectStore(spaces, { s3 })).toMatchObject({ ok: true, bucketExists: false });
  });

  it("names the fix when virtual-host addressing cannot resolve", async () => {
    const s3 = failing({ name: "ENOTFOUND" });
    const out = await validateObjectStore(spaces, { s3 });
    expect(out).toMatchObject({ ok: false, code: "addressing" });
    expect(out.ok === false && out.error).toMatch(/rigel-failover\.tor1\.digitaloceanspaces\.com/);
    expect(out.ok === false && out.error).toMatch(/host\/bucket/);
  });

  it("names the fix when path addressing is redirected", async () => {
    const s3 = failing({ Code: "PermanentRedirect" });
    const out = await validateObjectStore(garage, { s3 });
    expect(out).toMatchObject({ ok: false, code: "addressing" });
    expect(out.ok === false && out.error).toMatch(/bucket\.host/);
  });

  it("reports a rejected key pair", async () => {
    const s3 = failing({ Code: "SignatureDoesNotMatch" });
    expect(await validateObjectStore(spaces, { s3 })).toMatchObject({
      ok: false,
      error: "The store rejected this key pair.",
    });
  });

  it("flags a store that lives inside the cluster being failed away from", async () => {
    const s3 = { send: vi.fn().mockResolvedValue({}) };
    expect(await validateObjectStore(garage, { s3 })).toMatchObject({ insideSourceCluster: true });
    expect(await validateObjectStore(spaces, { s3 })).toMatchObject({ insideSourceCluster: false });
  });

  it("flags a tailnet address as inside the cluster too", async () => {
    const s3 = { send: vi.fn().mockResolvedValue({}) };
    const tailnet = { ...garage, endpoint: "http://100.85.103.61:3900" };
    expect(await validateObjectStore(tailnet, { s3 })).toMatchObject({ insideSourceCluster: true });
  });

  it("never puts a key in the result", async () => {
    const s3 = failing({ Code: "SignatureDoesNotMatch" });
    const out = await validateObjectStore(spaces, { s3 });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(JSON.stringify(out)).not.toContain("KEY");
  });
});

describe("uploadDir", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rigel-upload-"));
    await writeFile(join(dir, "bundle.yaml"), "kind: List\n");
    await mkdir(join(dir, "pg", "default", "postgres"), { recursive: true });
    await writeFile(join(dir, "pg", "default", "postgres", "globals.sql"), "-- roles\n");
    await writeFile(join(dir, "pg", "default", "postgres", "rigel.dump"), "PGDMP");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("walks nested directories and reports every key and the total bytes", async () => {
    const put = vi.fn(async () => {});
    const out = await uploadDir(spaces, "rigel-failover/home/20260904T1530Z", dir, { put });
    expect(put).toHaveBeenCalledTimes(3);

    expect(out.keys.sort()).toEqual([
      "rigel-failover/home/20260904T1530Z/bundle.yaml",
      "rigel-failover/home/20260904T1530Z/pg/default/postgres/globals.sql",
      "rigel-failover/home/20260904T1530Z/pg/default/postgres/rigel.dump",
    ]);
    expect(out.bytes).toBeGreaterThan(0);
  });

  it("uses forward slashes in keys regardless of the local path separator", async () => {
    const out = await uploadDir(spaces, "p", dir, { put: async () => {} });
    expect(out.keys.every((k) => !k.includes("\\"))).toBe(true);
  });
});
