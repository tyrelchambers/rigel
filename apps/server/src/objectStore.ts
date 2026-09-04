import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { endpointIsInsideSourceCluster } from "@rigel/k8s/src/failover/inClusterEndpoint";
import type { FailoverObjectStore, FailoverReporter } from "@rigel/k8s/src/failover/types";
import type { FailoverValidation } from "@rigel/k8s/src/failover/validation";

export type S3Like = Pick<S3Client, "send">;

/** Addressing is whatever the destination stored. Never guessed here. */
export function clientFor(store: FailoverObjectStore): S3Client {
  return new S3Client({
    endpoint: store.endpoint,
    region: store.region,
    forcePathStyle: store.addressing === "path",
    credentials: { accessKeyId: store.accessKey, secretAccessKey: store.secretKey },
  });
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return e.Code ?? e.code ?? e.name ?? "";
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

/**
 * A wrong addressing style is the one failure the user cannot read off an S3
 * error, so it gets named. `bucket.host` without wildcard DNS never resolves;
 * `host/bucket` against AWS is redirected.
 */
function addressingProblem(store: FailoverObjectStore, err: unknown): string | undefined {
  const code = errorCode(err);
  const status = httpStatus(err);
  if (store.addressing === "virtualHost" && /ENOTFOUND|EAI_AGAIN|ERR_TLS_CERT_ALTNAME_INVALID/i.test(code)) {
    const host = new URL(store.endpoint).host;
    return `Nothing answers at ${store.bucket}.${host}. Switch to host/bucket addressing and validate again.`;
  }
  if (store.addressing === "path" && (code === "PermanentRedirect" || status === 301)) {
    return "This store wants bucket.host addressing. Switch it and validate again.";
  }
  return undefined;
}

export async function validateObjectStore(
  store: FailoverObjectStore,
  deps: { s3?: S3Like } = {},
): Promise<NonNullable<FailoverValidation["objectStore"]>> {
  const s3 = deps.s3 ?? clientFor(store);
  const insideSourceCluster = endpointIsInsideSourceCluster(store.endpoint);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: store.bucket }) as never);
    return { ok: true, bucketExists: true, insideSourceCluster };
  } catch (err) {
    const code = errorCode(err);
    const status = httpStatus(err);
    if (status === 404 || code === "NotFound" || code === "NoSuchBucket") {
      return { ok: true, bucketExists: false, insideSourceCluster };
    }
    const addressing = addressingProblem(store, err);
    if (addressing) return { ok: false, code: "addressing", error: addressing };
    if (status === 403 || code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch") {
      return { ok: false, code, error: "The store rejected this key pair." };
    }
    return { ok: false, code, error: `No S3 endpoint answered at ${store.endpoint}: ${(err as Error).message}` };
  }
}

export async function createBucket(store: FailoverObjectStore, deps: { s3?: S3Like } = {}): Promise<void> {
  const s3 = deps.s3 ?? clientFor(store);
  await s3.send(new CreateBucketCommand({ Bucket: store.bucket }) as never);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export interface UploadResult {
  keys: string[];
  bytes: number;
}

export type PutObject = (key: string, file: string) => Promise<void>;

/** Multipart, from a read stream, so a multi-gigabyte dump never sits in memory. */
function multipartPut(store: FailoverObjectStore, client: S3Client): PutObject {
  return async (key, file) => {
    await new Upload({
      client,
      params: { Bucket: store.bucket, Key: key, Body: createReadStream(file) },
    }).done();
  };
}

/** Uploads every file under `dir` to `{prefix}/{relative path}`. */
export async function uploadDir(
  store: FailoverObjectStore,
  prefix: string,
  dir: string,
  deps: { put?: PutObject; onStep?: FailoverReporter } = {},
): Promise<UploadResult> {
  const put = deps.put ?? multipartPut(store, clientFor(store));
  const files = await walk(dir);
  const keys: string[] = [];
  let bytes = 0;

  for (const file of files) {
    const key = posix.join(prefix, relative(dir, file).split(sep).join("/"));
    await put(key, file);
    keys.push(key);
    bytes += (await stat(file)).size;
  }

  return { keys, bytes };
}
