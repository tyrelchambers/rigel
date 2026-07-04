// Kubernetes resource quantity parsing — shared by right-sizing (web) and the
// audit detection adapter (web + future CLI). Ported verbatim from
// apps/web/src/panels/rightsizing/displayHelper.ts.

const BINARY_MEM: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
};
const DECIMAL_MEM: Record<string, number> = {
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
};

/**
 * Parse a k8s quantity string.
 * - CPU → cores. "1500m" → 1.5, "4" → 4, "250m" → 0.25.
 * - Memory → bytes. "512Mi" → 536870912, "1Gi" → 1073741824.
 */
export function parseQuantity(value: string, type: "cpu" | "memory"): number {
  const v = value.trim();
  if (v === "") return 0;

  if (type === "cpu") {
    if (v.endsWith("m")) {
      const n = Number(v.slice(0, -1));
      return Number.isFinite(n) ? n / 1000 : 0;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  const bi = v.match(/^(\d+(?:\.\d+)?)([KMGTP]i)$/);
  if (bi) return Number(bi[1]) * BINARY_MEM[bi[2]];
  const dec = v.match(/^(\d+(?:\.\d+)?)([kMGTP])$/);
  if (dec) return Number(dec[1]) * DECIMAL_MEM[dec[2]];
  const plain = Number(v);
  return Number.isFinite(plain) ? plain : 0;
}
