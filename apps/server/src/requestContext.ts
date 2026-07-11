export function resolveRequestContext(
  header: string | null | undefined,
  bootContext: string | null,
): string | null {
  const h = typeof header === "string" ? header.trim() : "";
  return h !== "" ? h : bootContext;
}
