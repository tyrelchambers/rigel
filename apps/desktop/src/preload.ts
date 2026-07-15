import { contextBridge, ipcRenderer } from "electron";
import type { UpdateState } from "./appUpdater";

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
    me: (): Promise<{ account: { id: string; email: string; name: string | null }; orgs?: Array<{ id: string; kind: "personal" | "team"; name: string; role: "owner" | "admin" | "member" }>; invitations?: unknown[] } | null> =>
      ipcRenderer.invoke("rigel:account:me"),
    signOut: (): Promise<void> => ipcRenderer.invoke("rigel:account:sign-out"),
    status: (): Promise<{ signedIn: boolean; account: { id: string; email: string; name: string | null } | null; orgs: Array<{ id: string; kind: "personal" | "team"; name: string; role: "owner" | "admin" | "member" }> }> =>
      ipcRenderer.invoke("rigel:account:status"),
    onChanged: (cb: () => void): (() => void) => {
      const listener = () => cb();
      ipcRenderer.on("rigel:account:changed", listener);
      return () => ipcRenderer.removeListener("rigel:account:changed", listener);
    },
  },
  billing: {
    checkout: (orgId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("rigel:billing:checkout", orgId),
    portal: (orgId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("rigel:billing:portal", orgId),
    entitlements: () => ipcRenderer.invoke("rigel:billing:entitlements"),
    refresh: (): Promise<void> => ipcRenderer.invoke("rigel:billing:refresh"),
    onChanged: (cb: () => void): (() => void) => {
      const l = () => cb();
      ipcRenderer.on("rigel:billing:changed", l);
      return () => ipcRenderer.removeListener("rigel:billing:changed", l);
    },
  },
  appUpdate: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke("rigel:app-update:state"),
    check: (): Promise<void> => ipcRenderer.invoke("rigel:app-update:check"),
    download: (): Promise<void> => ipcRenderer.invoke("rigel:app-update:download"),
    install: (): Promise<void> => ipcRenderer.invoke("rigel:app-update:install"),
    open: (): Promise<void> => ipcRenderer.invoke("rigel:app-update:open"),
    onState: (cb: (s: UpdateState) => void): (() => void) => {
      const listener = (_e: unknown, s: UpdateState) => cb(s);
      ipcRenderer.on("rigel:app-update:state", listener);
      return () => ipcRenderer.removeListener("rigel:app-update:state", listener);
    },
  },
});
