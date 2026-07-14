import { SignInFlow } from "./SignInFlow";
import type { UseAccountResult } from "./useAccount";

/**
 * Full-screen sign-in gate. When signed out, the app renders ONLY this: a
 * graphite page with a centered card wrapping the shared SignInFlow.
 */
export function LoginGate({ account }: { account: UseAccountResult }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{ background: "var(--surface-sunken)" }}
    >
      <div className="w-full max-w-[400px] rounded-2xl border border-white/10 bg-[#101012] p-7 shadow-[0_30px_80px_rgba(0,0,0,0.44)]">
        <SignInFlow account={account} />
      </div>
    </div>
  );
}
