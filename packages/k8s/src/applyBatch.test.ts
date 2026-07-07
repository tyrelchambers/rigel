import { describe, expect, test } from "vitest";
import {
  LEDGER_LABEL_KEY,
  LEDGER_LABEL_VALUE,
  LEDGER_NAME_PREFIX,
  LEDGER_DATA_KEY,
  LEDGER_NAMESPACE,
  ledgerName,
  asApplySource,
} from "./applyBatch";

describe("ledger constants", () => {
  test("frozen rigel.dev ledger contract", () => {
    expect(LEDGER_LABEL_KEY).toBe("rigel.dev/ledger");
    expect(LEDGER_LABEL_VALUE).toBe("apply-batch");
    expect(LEDGER_NAME_PREFIX).toBe("rigel-apply-");
    expect(LEDGER_DATA_KEY).toBe("batch.json");
    expect(LEDGER_NAMESPACE).toBe("default");
  });

  test("ledgerName prefixes the batch id", () => {
    expect(ledgerName("abc-123")).toBe("rigel-apply-abc-123");
  });

  test("asApplySource narrows valid values only", () => {
    expect(asApplySource("compose-migration")).toBe("compose-migration");
    expect(asApplySource("catalog-install")).toBe("catalog-install");
    expect(asApplySource("apply-yaml")).toBe("apply-yaml");
    expect(asApplySource("bogus")).toBeNull();
    expect(asApplySource(undefined)).toBeNull();
  });
});
