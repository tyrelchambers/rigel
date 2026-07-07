export function isSecretEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  return (
    k.includes("PASSWORD") ||
    k.includes("SECRET") ||
    k.includes("TOKEN") ||
    k.includes("APIKEY") ||
    k.endsWith("_KEY")
  );
}
