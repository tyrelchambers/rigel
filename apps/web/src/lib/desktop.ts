export interface RigelBridge {
  desktop: true;
  platform: string;
  electronVersion: string;
  submitSignup(data: { name: string; email: string }): Promise<{ ok: true }>;
  getSignupData(): Promise<{ name: string; email: string } | null>;
  openChartFile?(): Promise<{ canceled: boolean; path?: string }>;
}
export const rigel: RigelBridge | undefined = (window as unknown as { rigel?: RigelBridge }).rigel;
export const isDesktop = !!rigel;
export const isMacDesktop = rigel?.platform === "darwin";
