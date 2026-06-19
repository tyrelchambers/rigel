export interface RigelBridge {
  desktop: true;
  electronVersion: string;
  needsSignup(): Promise<boolean>;
  submitSignup(data: { name: string; email: string }): Promise<{ ok: true }>;
}
export const rigel: RigelBridge | undefined = (window as unknown as { rigel?: RigelBridge }).rigel;
export const isDesktop = !!rigel;
