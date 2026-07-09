#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: set-versions.mjs X.Y.Z");
  process.exit(1);
}

const files = [
  "apps/desktop/package.json",
  "agent/package.json",
  "apps/marketing/package.json",
  "apps/web/package.json",
];

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const next = src.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
  if (next === src) {
    console.error(`no version field replaced in ${f}`);
    process.exit(1);
  }
  writeFileSync(f, next);
  console.log(`${f} -> ${version}`);
}
