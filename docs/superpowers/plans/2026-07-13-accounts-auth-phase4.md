# Accounts + Auth — Phase 4 (Account panel / login UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Replace the cosmetic `AccountModal` with a real passwordless account flow driven by the Phase-2 `rigel.account` bridge: signed-out (email → 6-digit code) and signed-in (real profile + Sign out), matching the approved Pencil design.

**Design (approved):** frame **"Accounts — Passwordless Sign-in (design)"** (`uTr7u`) in `/Users/tyrelchambers/Desktop/clankerlocal.pen`. Four states: (1) Enter email, (2) Enter code, (2b) Code error, (3) Signed in. The signed-in state reuses the existing Account Card design (avatar, name, email, Plan badge, Sign out, Done).

**Tech Stack:** React 19, TypeScript, Tailwind v4 + CSS-var tokens, shadcn Dialog primitives, `<Button>` (cva), Vitest + jsdom + RTL.

**Conventions (match these, NOT the old inline-style AccountModal):**
- Modal chrome = the existing Dialog primitives (`Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogBody` from `@/components/ui/dialog`). `DialogContent` already gives the `#101012` card.
- Use the `<Button>` component (`@/components/ui/button`) for the primary actions (`variant="default"` = accent fill).
- Token map (Pencil → web): `#38BDF8`→`--accent-primary` (Tailwind `bg-primary`/`text-primary`), button label `#04232E`→`text-primary-foreground`, input bg `#0C0D0F`→`--surface-sunken`, input border `#FFFFFF12`→`--border-subtle`, label `#9A9AA2`→`--fg-secondary`, filled text→`--fg-primary`, placeholder `#6B6B73`→`--fg-tertiary` (confirm it exists in `index.css`; else `--fg-secondary`), error→`text-destructive`/`bg-destructive/10`, avatar bg→`--accent-dim`.
- Prefer Tailwind utilities + mapped tokens; use `[var(--token)]` arbitrary values only where no mapped utility exists (mirroring `button.tsx`). Avoid `style={{}}` with raw hex/px.

**Scope:** the account MODAL flow only (opened from the header/menu). Do NOT change the first-run `AccountGate` name-capture gate in `App.tsx` (separate waitlist concern) — that's a follow-up product decision, out of scope here.

**Dependency:** live sign-in needs the backend `/auth/*` deployed (not yet). All Phase-4 work is component-tested with `rigel.account` mocked; live smoke is deferred to backend rollout.

---

## File structure

- Create `apps/web/src/shell/useAccount.ts` — the account state hook wrapping `rigel.account` (`me()` on mount → status; `requestCode`/`verifyCode`/`signOut`). One responsibility: account session state.
- Rewrite `apps/web/src/shell/AccountModal.tsx` — the full flow (signed-in panel + signed-out email/code steps). Takes `open`/`onOpenChange` + a `useAccount` result (injected for testability).
- Modify `apps/web/src/App.tsx` — use `useAccount()`; pass it to `AccountModal`; drop the `getSignupData`-based `account` state feeding the modal (keep everything else).
- Tests: `useAccount.test.ts`(x), `AccountModal.test.tsx` (rewrite for the new states).

---

## Task 1: `useAccount` hook

**Files:** Create `apps/web/src/shell/useAccount.ts`; Test `apps/web/src/shell/useAccount.test.tsx`.

- [ ] **Step 1: Write the failing test** (jsdom; mock `@/lib/desktop`). Cover: starts `loading` then resolves to `signed-in` when `me()` returns a payload; resolves to `signed-out` when `me()` returns null; `verifyCode` success triggers a refresh → `signed-in`; `signOut` → `signed-out`.

```tsx
// apps/web/src/shell/useAccount.test.tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const account = { id: "1", email: "a@b.co", name: "Jane" };
const me = vi.fn();
const requestCode = vi.fn();
const verifyCode = vi.fn();
const signOut = vi.fn();
vi.mock("@/lib/desktop", () => ({
  rigel: { account: { me: (...a: unknown[]) => me(...a), requestCode: (...a: unknown[]) => requestCode(...a), verifyCode: (...a: unknown[]) => verifyCode(...a), signOut: (...a: unknown[]) => signOut(...a) } },
}));

beforeEach(() => { me.mockReset(); requestCode.mockReset(); verifyCode.mockReset(); signOut.mockReset(); });
afterEach(() => vi.clearAllMocks());

test("resolves to signed-in when me() returns a payload", async () => {
  me.mockResolvedValue({ account });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  expect(result.current.status).toBe("loading");
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
  expect(result.current.account).toEqual(account);
});

test("resolves to signed-out when me() returns null", async () => {
  me.mockResolvedValue(null);
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-out"));
  expect(result.current.account).toBeNull();
});

test("verifyCode success refreshes to signed-in", async () => {
  me.mockResolvedValueOnce(null).mockResolvedValue({ account });
  verifyCode.mockResolvedValue({ ok: true, account });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-out"));
  await act(async () => { await result.current.verifyCode("a@b.co", "123456"); });
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
});

test("signOut returns to signed-out", async () => {
  me.mockResolvedValue({ account });
  signOut.mockResolvedValue(undefined);
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
  await act(async () => { await result.current.signOut(); });
  expect(result.current.status).toBe("signed-out");
  expect(signOut).toHaveBeenCalled();
});
```

- [ ] **Step 2:** `pnpm --filter web test useAccount` → FAIL (module missing).

- [ ] **Step 3: Implement** `apps/web/src/shell/useAccount.ts`:

```typescript
import { useCallback, useEffect, useState } from "react";
import { rigel, type Account, type MePayload, type VerifyResult } from "@/lib/desktop";

export type AccountStatus = "loading" | "signed-out" | "signed-in";

export interface UseAccountResult {
  status: AccountStatus;
  account: Account | null;
  me: MePayload | null;
  requestCode(email: string): Promise<{ ok: boolean; status: number }>;
  verifyCode(email: string, code: string): Promise<VerifyResult>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

export function useAccount(): UseAccountResult {
  const [me, setMe] = useState<MePayload | null>(null);
  const [status, setStatus] = useState<AccountStatus>(rigel ? "loading" : "signed-out");

  const refresh = useCallback(async () => {
    if (!rigel) { setStatus("signed-out"); return; }
    const payload = await rigel.account.me();
    setMe(payload);
    setStatus(payload ? "signed-in" : "signed-out");
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const requestCode = useCallback(
    (email: string) => rigel!.account.requestCode(email),
    [],
  );
  const verifyCode = useCallback(
    async (email: string, code: string): Promise<VerifyResult> => {
      const r = await rigel!.account.verifyCode(email, code);
      if (r.ok) await refresh();
      return r;
    },
    [refresh],
  );
  const signOut = useCallback(async () => {
    await rigel?.account.signOut();
    setMe(null);
    setStatus("signed-out");
  }, []);

  return { status, account: me?.account ?? null, me, requestCode, verifyCode, signOut, refresh };
}
```

- [ ] **Step 4:** `pnpm --filter web test useAccount` → PASS. `pnpm --filter web typecheck` → clean.
- [ ] **Step 5: Commit** `feat(web): useAccount hook (rigel.account session state)`.

---

## Task 2: `AccountModal` rewrite (the flow)

**Files:** Rewrite `apps/web/src/shell/AccountModal.tsx`; rewrite `apps/web/src/shell/AccountModal.test.tsx`.

**Props:** `{ open: boolean; onOpenChange(o:boolean):void; account: UseAccountResult }` — the hook result is injected so tests can drive states without the bridge.

**Behavior / states (match design `uTr7u`):**
- `account.status === "signed-in"`: the account panel — avatar (User icon on `--accent-dim`), `account.account.name` (fallback to the email's local part or "Signed in" when name is null), `account.account.email` (mono), a **Plan** row with the badge (still "Free" — HELM-16 fills it), footer with **Sign out** (calls `account.signOut()`; neutral, not destructive) and **Done** (`onOpenChange(false)`).
- signed-out, local `step === "email"`: brand + "Sign in to Rigel" + sub, one Email input, **Send code** button. On submit → `account.requestCode(email)`; on `{ok:true}` go to `step="code"`; on `429` show "Too many requests, try again in a few minutes"; on `502`/`!ok` show "Couldn't send a code. Try again."; disable button while sending.
- signed-out, `step === "code"`: "Check your email" + "We sent a 6-digit code to {email}…", a 6-box code input (a single controlled text of up to 6 digits is acceptable for v1 — render 6 boxes reading from it), **Verify & sign in**, and a row with **Resend code** (calls `requestCode` again) + **Use a different email** (back to `step="email"`). On verify → `account.verifyCode(email, code)`; `{ok:true}` closes/shows signed-in (the hook flips status); `{ok:false, status:401}` → inline error "That code is invalid or expired. Request a new one." and mark boxes invalid; `429` → "Too many attempts…".
- Loading (`status === "loading"`): render the Dialog with a minimal centered spinner/placeholder (avoid a flash of the sign-in form).

Keep it one component with a local `step`/`email`/`code`/`error`/`busy` state via `useState`. Reset local state when the modal closes (`open` false) or on sign-in.

- [ ] **Step 1: Write the failing tests** `AccountModal.test.tsx` (jsdom + RTL). A helper builds a fake `UseAccountResult`. Cover:
  - signed-in: shows name, email, "Free", "Sign out", "Done"; "Done" calls `onOpenChange(false)`; "Sign out" calls `account.signOut`.
  - signed-out email step: shows "Sign in to Rigel" + a "Send code" button; submitting a valid email calls `requestCode` and advances to the code step ("Check your email").
  - code step: entering 6 digits + "Verify & sign in" calls `verifyCode(email, "123456")`.
  - code error: when `verifyCode` resolves `{ok:false,status:401}`, an invalid-code message appears.

```tsx
// apps/web/src/shell/AccountModal.test.tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountModal } from "./AccountModal";
import type { UseAccountResult } from "./useAccount";

afterEach(cleanup);

function fakeAccount(over: Partial<UseAccountResult> = {}): UseAccountResult {
  return {
    status: "signed-out",
    account: null,
    me: null,
    requestCode: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    verifyCode: vi.fn().mockResolvedValue({ ok: true, account: { id: "1", email: "a@b.co", name: "Jane" } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

test("signed-in shows profile + actions", () => {
  const acc = fakeAccount({ status: "signed-in", account: { id: "1", email: "tychambers3@gmail.com", name: "Tyrel Chambers" }, me: { account: { id: "1", email: "tychambers3@gmail.com", name: "Tyrel Chambers" } } });
  const onOpenChange = vi.fn();
  render(<AccountModal open onOpenChange={onOpenChange} account={acc} />);
  expect(screen.getByText("Tyrel Chambers")).toBeTruthy();
  expect(screen.getByText("tychambers3@gmail.com")).toBeTruthy();
  expect(screen.getByText("Sign out")).toBeTruthy();
  fireEvent.click(screen.getByText("Done"));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByText("Sign out"));
  expect(acc.signOut).toHaveBeenCalled();
});

test("email step sends a code and advances", async () => {
  const acc = fakeAccount();
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  expect(screen.getByText("Sign in to Rigel")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("jane@acme.com"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByText("Send code"));
  await waitFor(() => expect(acc.requestCode).toHaveBeenCalledWith("a@b.co"));
  await waitFor(() => expect(screen.getByText(/Check your email/)).toBeTruthy());
});

test("code step verifies", async () => {
  const acc = fakeAccount();
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  fireEvent.change(screen.getByPlaceholderText("jane@acme.com"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByText("Send code"));
  await waitFor(() => screen.getByText(/Check your email/));
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByText("Verify & sign in"));
  await waitFor(() => expect(acc.verifyCode).toHaveBeenCalledWith("a@b.co", "123456"));
});

test("invalid code shows an error", async () => {
  const acc = fakeAccount({ verifyCode: vi.fn().mockResolvedValue({ ok: false, status: 401 }) });
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  fireEvent.change(screen.getByPlaceholderText("jane@acme.com"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByText("Send code"));
  await waitFor(() => screen.getByText(/Check your email/));
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "000000" } });
  fireEvent.click(screen.getByText("Verify & sign in"));
  await waitFor(() => expect(screen.getByText(/invalid or expired/i)).toBeTruthy());
});
```

- [ ] **Step 2:** `pnpm --filter web test AccountModal` → FAIL (old modal, new tests).

- [ ] **Step 3: Implement** the rewrite matching the design. Build with Dialog primitives + `<Button>`. Use a hidden/visually-styled controlled input for the code (with `aria-label="Verification code"`, `inputMode="numeric"`, `maxLength={6}`) rendered as 6 boxes; keep the accessible input so the test's `getByLabelText("Verification code")` works. Follow the token map above; no raw-hex `style`. Reset local state on `open===false` via an effect. Keep the component focused; if it grows past ~200 lines, that's acceptable for a multi-state modal but extract the code-box subview into a small local component in the same file.

- [ ] **Step 4:** `pnpm --filter web test AccountModal` → PASS. `pnpm --filter web typecheck` → clean.
- [ ] **Step 5: Commit** `feat(web): real passwordless AccountModal (email → code → signed in)`.

---

## Task 3: Wire `AccountModal` in `App.tsx`

**Files:** Modify `apps/web/src/App.tsx`.

- [ ] **Step 1:** Add `const account = useAccount();` (import from `@/shell/useAccount`).
- [ ] **Step 2:** Replace the `<AccountModal open={accountOpen} onOpenChange={setAccountOpen} name={account?.name} email={account?.email} />` usage with `<AccountModal open={accountOpen} onOpenChange={setAccountOpen} account={account} />`. Remove the now-unused `getSignupData`-fed `account` state + its effect that only fed the modal (the `[account,setAccount]` at App.tsx:112 and the effect at 113-121). Leave the first-run `accountMissing` gate + `AccountGate` untouched.
- [ ] **Step 3:** `pnpm --filter web typecheck` → clean; `pnpm --filter web test` → green (no regressions).
- [ ] **Step 4: Commit** `feat(web): wire real account session into the header AccountModal`.

---

## Phase 4 verification

- [ ] `pnpm --filter web typecheck` clean; `pnpm --filter web test` green.
- [ ] Visually compare the built modal states against design frame `uTr7u` (via `pnpm --filter desktop dev` when the backend is reachable, or Vitest DOM snapshots). Live sign-in smoke deferred to backend rollout.

## Self-review notes (author)
- Covers spec Component 4 (signed-out email→code + signed-in, neutral Sign out, Plan placeholder). States sending/rate-limited/error handled inline per the design's error variant.
- Type consistency: `Account`/`MePayload`/`VerifyResult` come from `@/lib/desktop` (Phase-3 typing task added them). `UseAccountResult` is the single shape shared by the hook, the modal prop, and the tests.
