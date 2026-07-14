import { contextBridge, ipcRenderer } from "electron";

const sessionArg = process.argv.find((a) => a.startsWith("--rigel-session="));
const sessionSecret = sessionArg ? sessionArg.slice("--rigel-session=".length) : "";

contextBridge.exposeInMainWorld("rigel", {
  desktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron,
  sessionSecret,
  /** Record + deliver the signup. Resolves once captured locally (delivery retries in the background). */
  submitSignup: (data: { name: string; email: string }): Promise<{ ok: true }> =>
    ipcRenderer.invoke("rigel:submit-signup", data),
  /** The captured name+email for the Account panel, or null if unavailable. */
  getSignupData: (): Promise<{ name: string; email: string } | null> =>
    ipcRenderer.invoke("rigel:get-signup-data"),
  openChartFile: (): Promise<{ canceled: boolean; path?: string }> =>
    ipcRenderer.invoke("rigel:open-chart-file"),
  account: {
    requestCode: (email: string): Promise<{ ok: boolean; status: number }> =>
      ipcRenderer.invoke("rigel:account:request-code", email),
    verifyCode: (email: string, code: string): Promise<{ ok: true; account: { id: string; email: string; name: string | null } } | { ok: false; status: number }> =>
      ipcRenderer.invoke("rigel:account:verify-code", { email, code }),
    me: (): Promise<{ account: { id: string; email: string; name: string | null }; orgs?: unknown[]; invitations?: unknown[] } | null> =>
      ipcRenderer.invoke("rigel:account:me"),
    signOut: (): Promise<void> => ipcRenderer.invoke("rigel:account:sign-out"),
    status: (): Promise<{ signedIn: boolean; account: { id: string; email: string; name: string | null } | null }> =>
      ipcRenderer.invoke("rigel:account:status"),
    onChanged: (cb: () => void): (() => void) => {
      const listener = () => cb();
      ipcRenderer.on("rigel:account:changed", listener);
      return () => ipcRenderer.removeListener("rigel:account:changed", listener);
    },
  },
});
