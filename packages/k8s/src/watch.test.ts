import { test, expect } from "vitest";
import { WatchEventParser } from "./watch";

test("emits one event per complete JSON object across chunk boundaries", () => {
  const p = new WatchEventParser();
  const events: { type: string; name: string }[] = [];
  const sink = (e: any) => events.push({ type: e.type, name: e.object.metadata.name });

  p.push('{"type":"ADDED","object":{"metadata":{"name":"a"', sink);
  p.push('}}}{"type":"MODIFIED","object":{"metadata":{"name":"b"}}}', sink);

  expect(events).toEqual([
    { type: "ADDED", name: "a" },
    { type: "MODIFIED", name: "b" },
  ]);
});

test("does not mis-frame on braces inside string values", () => {
  const p = new WatchEventParser();
  const out: any[] = [];
  p.push('{"type":"ADDED","object":{"metadata":{"name":"a","annotations":{"x":"v{}{"}}}}}', (e) => out.push(e));
  expect(out.length).toBe(1);
  expect(out[0].object.metadata.name).toBe("a");
});
