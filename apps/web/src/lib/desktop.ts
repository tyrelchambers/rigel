export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  version: string | null;
  progress: number;
  /** True when the update can be installed in place; false = download-page only. */
  canAutoInstall: boolean;
  error: string | null;
}
export interface EntitlementPayload {
  plan: "free" | "pro";
  audits: ("reliability" | "security" | "performance")[];
  cloudConnect: boolean;
  agentAutonomy: boolean;
  fetchedAt: string;
}
export interface Account { id: string; email: string; name: string | null }
export interface Org { id: string; kind: "personal" | "team"; name: string; role: "owner" | "admin" | "member" }
export interface MePayload { account: Account; orgs?: Org[]; invitations?: unknown[] }
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
    status(): Promise<{ signedIn: boolean; account: Account | null; orgs: Org[] }>;
    onChanged(cb: () => void): () => void;
  };
  billing?: {
    checkout(orgId: string): Promise<{ ok: boolean }>;
    portal(orgId: string): Promise<{ ok: boolean }>;
    entitlements(): Promise<EntitlementPayload | null>;
    refresh(): Promise<void>;
    onChanged(cb: () => void): () => void;
  };
  appUpdate?: {
    getState(): Promise<UpdateState>;
    check(): Promise<void>;
    download(): Promise<void>;
    install(): Promise<void>;
    open(): Promise<void>;
    onState(cb: (s: UpdateState) => void): () => void;
  };
}
export const rigel: RigelBridge | undefined =
  typeof window !== "undefined" ? (window as unknown as { rigel?: RigelBridge }).rigel : undefined;
export const isDesktop = !!rigel;
export const isMacDesktop = rigel?.platform === "darwin";
