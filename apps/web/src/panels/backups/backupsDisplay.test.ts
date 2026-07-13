import { describe, expect, it } from "vitest";
import {
  backupMethod,
  backupStatus,
  durationSeconds,
  eventBadgeVariant,
  formatDuration,
  methodLabel,
  statusLabel,
} from "./backupsDisplay";

describe("backupStatus", () => {
  it("maps CNPG phases to a normalized status", () => {
    expect(backupStatus("completed")).toBe("completed");
    expect(backupStatus("failed")).toBe("failed");
    expect(backupStatus("running")).toBe("running");
    expect(backupStatus("started")).toBe("running");
    expect(backupStatus("pending")).toBe("running");
    expect(backupStatus("weird")).toBe("other");
    expect(backupStatus(undefined)).toBe("other");
  });
});

describe("backupMethod / methodLabel", () => {
  it("maps CNPG spec.method values", () => {
    expect(backupMethod("barmanObjectStore")).toBe("objectStore");
    expect(backupMethod("volumeSnapshot")).toBe("volumeSnapshot");
    expect(backupMethod("plugin")).toBe("plugin");
    expect(backupMethod(undefined)).toBe("unknown");
  });
  it("labels methods for display", () => {
    expect(methodLabel("objectStore")).toBe("Object store");
    expect(methodLabel("volumeSnapshot")).toBe("Volume snapshot");
    expect(methodLabel("plugin")).toBe("Plugin");
    expect(methodLabel("unknown")).toBe("—");
  });
});

describe("eventBadgeVariant / statusLabel", () => {
  it("maps status to a StatusBadge variant", () => {
    expect(eventBadgeVariant("completed")).toBe("healthy");
    expect(eventBadgeVariant("ready")).toBe("healthy");
    expect(eventBadgeVariant("failed")).toBe("error");
    expect(eventBadgeVariant("running")).toBe("pending");
    expect(eventBadgeVariant("notReady")).toBe("pending");
    expect(eventBadgeVariant("other")).toBe("neutral");
  });
  it("labels status", () => {
    expect(statusLabel("notReady")).toBe("not ready");
    expect(statusLabel("completed")).toBe("completed");
  });
});

describe("durationSeconds / formatDuration", () => {
  it("computes seconds between start and stop", () => {
    expect(
      durationSeconds("2026-07-13T10:00:00Z", "2026-07-13T10:01:30Z"),
    ).toBe(90);
  });
  it("returns undefined when a bound is missing or invalid", () => {
    expect(durationSeconds(undefined, "2026-07-13T10:01:30Z")).toBeUndefined();
    expect(durationSeconds("2026-07-13T10:05:00Z", "2026-07-13T10:00:00Z")).toBeUndefined();
  });
  it("formats durations compactly", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3720)).toBe("1h 2m");
  });
});
