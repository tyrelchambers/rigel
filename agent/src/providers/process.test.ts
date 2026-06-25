import { test, expect, describe } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { collectJsonlRun, type CollectedEvent } from "./process.js";

/** A fake CLI on PATH that prints the given lines then exits with `code`. */
async function fakeCli(name: string, lines: string[], code = 0): Promise<{ dir: string; restore: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), `rigel-fake-${name}-`));
  const bin = join(dir, name);
  await writeFile(bin, ["#!/bin/sh", ...lines.map((l) => `echo '${l}'`), `exit ${code}`].join("\n") + "\n");
  await chmod(bin, 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${prev ?? ""}`;
  return { dir, restore: () => { process.env.PATH = prev; } };
}

/** Trivial mapper: {kind:"text",text} → text event; {kind:"err",text} → error. */
function mapEvent(ev: any): CollectedEvent[] {
  if (ev?.kind === "text") return [{ type: "text", text: ev.text }];
  if (ev?.kind === "session") return [{ type: "session", sessionId: ev.id }];
  if (ev?.kind === "err") return [{ type: "error", text: ev.text }];
  return [];
}

describe("collectJsonlRun", () => {
  test("collects final text + session, no error, on clean exit", async () => {
    const f = await fakeCli("fakecli", [
      `{"kind":"session","id":"s1"}`,
      `{"kind":"text","text":"part one. "}`,
      `{"kind":"text","text":"part two."}`,
    ]);
    try {
      const r = await collectJsonlRun({ argv: ["fakecli"], env: process.env as Record<string, string>, mapEvent });
      expect(r.text).toBe("part one. part two.");
      expect(r.sessionId).toBe("s1");
      expect(r.isError).toBe(false);
    } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
  });

  test("a mapped error event makes the run an error", async () => {
    const f = await fakeCli("fakecli2", [`{"kind":"err","text":"boom"}`]);
    try {
      const r = await collectJsonlRun({ argv: ["fakecli2"], env: process.env as Record<string, string>, mapEvent });
      expect(r.isError).toBe(true);
      expect(r.errorText).toBe("boom");
    } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
  });

  test("a non-zero exit with no error event surfaces stderr/exit as the error", async () => {
    const f = await fakeCli("fakecli3", [`{"kind":"text","text":"hi"}`], 7);
    try {
      const r = await collectJsonlRun({ argv: ["fakecli3"], env: process.env as Record<string, string>, mapEvent });
      expect(r.isError).toBe(true);
      expect(r.errorText).toMatch(/exited with code 7|code 7/);
    } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
  });

  test("ENOENT (binary not found) is reported as an error, not a throw", async () => {
    const r = await collectJsonlRun({ argv: ["definitely-not-a-real-binary-xyz"], env: process.env as Record<string, string>, mapEvent });
    expect(r.isError).toBe(true);
    expect(r.errorText).toMatch(/ENOENT|not be found/i);
  });
});
