import { test, expect } from "vitest";
import { createApp } from "./app";
import type { Signup } from "./validate";

const valid = {
  installId: "11111111-1111-4111-8111-111111111111",
  name: "Jane",
  email: "jane@acme.com",
  appVersion: "0.1.0",
  platform: "darwin",
};

function make(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const calls: Signup[] = [];
  const app = createApp({ appKey: "secret", upsert: async (s) => { calls.push(s); }, allow: () => true, ...over });
  return { app, calls };
}

const post = (app: ReturnType<typeof createApp>, body: unknown, key = "secret") =>
  app.request("/signups", {
    method: "POST",
    headers: { "content-type": "application/json", "x-rigel-key": key },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("health is 200", async () => {
  const { app } = make();
  expect((await app.request("/health")).status).toBe(200);
});

test("valid signup → 200 and upsert called", async () => {
  const { app, calls } = make();
  const res = await post(app, valid);
  expect(res.status).toBe(200);
  expect(calls).toEqual([valid]);
});

test("wrong app key → 401, no upsert", async () => {
  const { app, calls } = make();
  expect((await post(app, valid, "wrong")).status).toBe(401);
  expect(calls.length).toBe(0);
});

test("invalid body → 400", async () => {
  const { app } = make();
  expect((await post(app, { ...valid, email: "nope" })).status).toBe(400);
});

test("malformed JSON → 400", async () => {
  const { app } = make();
  expect((await post(app, "{not json")).status).toBe(400);
});

test("rate-limited → 429", async () => {
  const { app } = make({ allow: () => false });
  expect((await post(app, valid)).status).toBe(429);
});
