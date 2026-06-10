/** When HELMSMAN_TOKEN is set, require `Authorization: Bearer <token>`. */
export function checkAuth(authHeader: string | undefined, token: string | null): boolean {
  if (!token) return true;
  return authHeader === `Bearer ${token}`;
}
