export interface RigelBridge {
  desktop: true;
  electronVersion: string;
  submitSignup(data: { name: string; email: string }): Promise<{ ok: true }>;
  getSignupData(): Promise<{ name: string; email: string } | null>;
  openChartFile?(): Promise<{ canceled: boolean; path?: string }>;
}
export const rigel: RigelBridge | undefined = (window as unknown as { rigel?: RigelBridge }).rigel;
export const isDesktop = !!rigel;
