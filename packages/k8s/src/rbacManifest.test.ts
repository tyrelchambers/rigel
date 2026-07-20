import { test, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rbacManifest } from "./assistant";

const FILE = resolve(__dirname, "../../../agent/manifests/rbac.yaml");

// agent/manifests/rbac.yaml is a generated snapshot, not a source of truth —
// editing it has no effect on what installs. This guard keeps it byte-equal to
// rbac()'s default output so it can never silently drift. Run with UPDATE_RBAC=1
// to regenerate it after an intentional policy/baseline change.
test("agent/manifests/rbac.yaml matches the generated default manifest", () => {
  const expected = rbacManifest("default");
  if (process.env.UPDATE_RBAC) {
    writeFileSync(FILE, expected);
    return;
  }
  expect(readFileSync(FILE, "utf8")).toBe(expected);
});
