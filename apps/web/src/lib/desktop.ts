export interface Account { id: string; email: string; name: string | null }
export interface MePayload { account: Account; orgs?: unknown[]; invitations?: unknown[] }
export type VerifyResult = { ok: true; account: Account } | { ok: false; status: number };

export interface RigelBridge {
  desktop: true;
  platform: string;
  electronVersion: string;
  sessionSecret: string;
  submitSignup(data: { name: string; email: string }): Promise<{ ok: true }>;
  getSignupData(): Promise<{ name: string; email: string } | null>;
  openChartFile?(): Promise<{ canceled: boolean; path?: string }>;
  account: {
    requestCode(email: string): Promise<{ ok: boolean; status: number }>;
    verifyCode(email: string, code: string): Promise<VerifyResult>;
    me(): Promise<MePayload | null>;
    signOut(): Promise<void>;
    status(): Promise<{ signedIn: boolean; account: Account | null }>;
  };
}
export const rigel: RigelBridge | undefined =
  typeof window !== "undefined" ? (window as unknown as { rigel?: RigelBridge }).rigel : undefined;
export const isDesktop = !!rigel;
export const isMacDesktop = rigel?.platform === "darwin";
