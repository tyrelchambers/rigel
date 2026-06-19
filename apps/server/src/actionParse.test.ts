import { test, expect } from "vitest";
import { extractActionBlocks } from "./claudeBridge";

test("extracts fenced action blocks as parsed objects", () => {
  const md = 'Restarting now.\n```action\n{"label":"Restart memos","kind":"restart","name":"memos","namespace":"default"}\n```\nDone.';
  expect(extractActionBlocks(md)).toEqual([
    { label: "Restart memos", kind: "restart", name: "memos", namespace: "default" },
  ]);
});

test("ignores non-action fences", () => {
  expect(extractActionBlocks("```bash\nls\n```")).toEqual([]);
});

test("skips malformed action JSON without throwing", () => {
  expect(extractActionBlocks("```action\n{not valid json}\n```")).toEqual([]);
});
