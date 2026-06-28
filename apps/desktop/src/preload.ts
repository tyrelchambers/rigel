import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("rigel", {
  desktop: true,
  electronVersion: process.versions.electron,
  /** True on first run until the user has submitted name+email. */
  needsSignup: (): Promise<boolean> => ipcRenderer.invoke("rigel:needs-signup"),
  /** Record + deliver the signup. Resolves once captured locally (delivery retries in the background). */
  submitSignup: (data: { name: string; email: string }): Promise<{ ok: true }> =>
    ipcRenderer.invoke("rigel:submit-signup", data),
  /** The captured name+email for the Account panel, or null if unavailable. */
  getSignupData: (): Promise<{ name: string; email: string } | null> =>
    ipcRenderer.invoke("rigel:get-signup-data"),
  openChartFile: (): Promise<{ canceled: boolean; path?: string }> =>
    ipcRenderer.invoke("rigel:open-chart-file"),
});
