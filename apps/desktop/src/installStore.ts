import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SignupPayload {
  installId: string;
  name: string;
  email: string;
  appVersion: string;
  platform: string;
}
interface State { installId: string; captured: boolean; pending: SignupPayload | null }

export class InstallStore {
  private file: string;
  private state: State;
  constructor(userDataDir: string) {
    this.file = join(userDataDir, "rigel-install.json");
    this.state = this.load();
    if (!this.state.installId) { this.state.installId = randomUUID(); this.save(); }
  }
  private load(): State {
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      return { installId: s.installId ?? "", captured: !!s.captured, pending: s.pending ?? null };
    } catch { return { installId: "", captured: false, pending: null }; }
  }
  private save() { writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 }); }
  get installId() { return this.state.installId; }
  get captured() { return this.state.captured; }
  get pending() { return this.state.pending; }
  setCapturedWithPending(p: SignupPayload) { this.state.captured = true; this.state.pending = p; this.save(); }
  clearPending() { this.state.pending = null; this.save(); }
}
