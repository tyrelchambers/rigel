import { test, expect } from "vitest";
import { backupKubeconfigPath, backupKubeconfig } from "./kubeconfigBackup";

test("backupKubeconfigPath puts a timestamped rigel-backup next to the source", () => {
  expect(backupKubeconfigPath("/home/u/.kube/config", "20260621-101500"))
    .toBe("/home/u/.kube/config.rigel-backup-20260621-101500");
});

test("backupKubeconfig copies the file and returns the new path", async () => {
  const copies: Array<[string, string]> = [];
  const fs = {
    existsSync: () => true,
    copyFile: async (src: string, dst: string) => { copies.push([src, dst]); },
  };
  const out = await backupKubeconfig("/k/config", () => "20260621-101500", fs);
  expect(out).toBe("/k/config.rigel-backup-20260621-101500");
  expect(copies).toEqual([["/k/config", "/k/config.rigel-backup-20260621-101500"]]);
});

test("backupKubeconfig returns null when the source doesn't exist", async () => {
  const fs = { existsSync: () => false, copyFile: async () => {} };
  expect(await backupKubeconfig("/k/config", () => "x", fs)).toBeNull();
});

test("backupKubeconfig returns null (non-fatal) when the copy throws", async () => {
  const fs = { existsSync: () => true, copyFile: async () => { throw new Error("EACCES"); } };
  expect(await backupKubeconfig("/k/config", () => "x", fs)).toBeNull();
});
