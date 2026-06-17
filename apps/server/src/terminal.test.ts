import { test, expect } from "bun:test";
import { TerminalSession } from "./terminal";

/** Concatenate the decoded payloads of every `term`/`data` frame. */
function collectData(frames: string[]): string {
  let out = "";
  for (const f of frames) {
    const m = JSON.parse(f);
    if (m.type === "term" && m.event === "data") out += m.data;
  }
  return out;
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Real PTY (Bun 1.3.5+ native terminal). No mocks — the session is pure I/O glue,
// so the meaningful test is that bytes actually flow and the shell exits cleanly.
test("TerminalSession streams shell output and reports exit", async () => {
  const frames: string[] = [];
  // TerminalSession only ever calls ws.send(string), so a minimal stub suffices.
  const sess = new TerminalSession({ send: (s: string) => frames.push(s) } as never);
  sess.start(80, 24);

  // First any data (the prompt), then run a command and see its output.
  await waitFor(() => frames.some((f) => JSON.parse(f).event === "data"));
  sess.write("echo HELMSMAN_PTY_OK\n");
  await waitFor(() => collectData(frames).includes("HELMSMAN_PTY_OK"));

  sess.write("exit\n");
  await waitFor(() => frames.some((f) => JSON.parse(f).event === "exit"));

  expect(collectData(frames)).toContain("HELMSMAN_PTY_OK");
  expect(frames.some((f) => JSON.parse(f).event === "exit")).toBe(true);
});
